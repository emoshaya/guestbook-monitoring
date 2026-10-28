// based on pulumi/examples/kubernetes-ts-guestbook (Apache-2.0)
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checksum, loadBalancerUrl, positiveInteger } from "./helpers";

const config = new pulumi.Config();
// require a context so deployment does not depend on the current kubectl selection
const context = config.require("kubernetesContext");
const provider = new k8s.Provider("cluster", { context });
const opts = { provider };
const namespaceName = config.get("namespace") || `guestbook-${pulumi.getStack().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespaceName)) {
    throw new Error("namespace must be a valid Kubernetes DNS label (maximum 63 characters)");
}
const serviceType = config.get("serviceType") || "NodePort";
if (!["NodePort", "LoadBalancer"].includes(serviceType)) {
    throw new Error("serviceType must be NodePort or LoadBalancer");
}
const frontendReplicas = positiveInteger(config.getNumber("frontendReplicas") ?? 3, "frontendReplicas");
const redisReplicas = positiveInteger(config.getNumber("redisReplicas") ?? 2, "redisReplicas");
const nodeAddress = config.get("nodeAddress");
if (nodeAddress && !/^[a-zA-Z0-9.:-]+$/.test(nodeAddress)) {
    throw new Error("nodeAddress must be an IP address or hostname without a scheme or path");
}

const images = {
    // the upstream PHP image is amd64 only; pin the digest for repeatable deployments
    frontend: config.get("frontendImage") || "pulumi/guestbook-php-redis@sha256:f21cbff35c0bad29d0c480f741e19919fb135d7c7941b8b5fc7240503d0a1c4f",
    redis: "redis:8-alpine@sha256:47b08295737773de3b711fb86f13ae802f5074e96a9a2d29f5f80164ac08c046",
    nginx: "nginx:1.30.0-alpine@sha256:0272e4604ed93c1792f03695a033a6e8546840f86e0de20a884bb17d2c924883",
    nginxExporter: "nginx/nginx-prometheus-exporter:1.5.3",
    redisExporter: "oliver006/redis_exporter:v1.96.0",
    prometheus: "prom/prometheus:v3.15.1",
    grafana: "grafana/grafana:13.3.0",
};
const ns = new k8s.core.v1.Namespace("guestbook", { metadata: { name: namespaceName } }, opts);
const labels = (component: string) => ({ "app.kubernetes.io/part-of": "guestbook", component });
const meta = (name: string) => ({ name, namespace: ns.metadata.name, labels: labels(name) });
const read = (file: string) => readFileSync(join(__dirname, file), "utf8");
const smallResources = { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } };
const tcpProbe = (port: string | number) => ({ tcpSocket: { port }, initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 5 });

function metricsService(component: string, port: number) {
    return new k8s.core.v1.Service(`${component}-metrics`, {
        metadata: {
            ...meta(`${component}-metrics`),
            labels: labels(component),
            annotations: { "prometheus.io/scrape": "true", "prometheus.io/path": "/metrics" },
        },
        spec: { type: "ClusterIP", selector: labels(component), ports: [{ name: "metrics", port, targetPort: "metrics" }] },
    }, opts);
}

// keep the service names expected by the PHP app
for (const component of ["redis-leader", "redis-replica"]) {
    const replica = component === "redis-replica";
    new k8s.apps.v1.Deployment(component, {
        metadata: meta(component),
        spec: {
            replicas: replica ? redisReplicas : 1,
            // only one leader should serve writes during a rollout
            strategy: { type: "Recreate" },
            selector: { matchLabels: labels(component) },
            template: {
                metadata: { labels: labels(component) },
                spec: {
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: "redis", image: images.redis,
                            args: ["redis-server", "--save", "", "--appendonly", "no", ...(replica ? ["--replicaof", "redis-leader", "6379"] : [])],
                            ports: [{ name: "redis", containerPort: 6379 }],
                            resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
                            readinessProbe: {
                                exec: { command: replica
                                    ? ["sh", "-c", "redis-cli info replication | grep -q 'master_link_status:up'"]
                                    : ["redis-cli", "ping"] },
                                initialDelaySeconds: 5, periodSeconds: 5, timeoutSeconds: 5,
                            },
                            livenessProbe: { exec: { command: ["redis-cli", "ping"] }, initialDelaySeconds: 15, periodSeconds: 10, timeoutSeconds: 5 },
                        },
                        {
                            name: "redis-exporter", image: images.redisExporter,
                            args: ["--redis.addr=redis://127.0.0.1:6379"],
                            ports: [{ name: "metrics", containerPort: 9121 }], resources: smallResources,
                            readinessProbe: tcpProbe("metrics"), livenessProbe: tcpProbe("metrics"),
                            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                        },
                    ],
                },
            },
        },
    }, opts);
    new k8s.core.v1.Service(component, {
        metadata: meta(component),
        spec: { selector: labels(component), ports: [{ name: "redis", port: 6379, targetPort: "redis" }] },
    }, opts);
    metricsService(component, 9121);
}

const nginxText = read("config/nginx.conf");
const nginxConfig = new k8s.core.v1.ConfigMap("nginx-config", { metadata: meta("nginx-config"), data: { "nginx.conf": nginxText } }, opts);
new k8s.apps.v1.Deployment("frontend", {
    metadata: meta("frontend"),
    spec: {
        replicas: frontendReplicas,
        selector: { matchLabels: labels("frontend") },
        template: {
            metadata: { labels: labels("frontend"), annotations: { "checksum/nginx": checksum(nginxText) } },
            spec: {
                automountServiceAccountToken: false,
                containers: [
                    {
                        name: "frontend", image: images.frontend,
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ name: "php-http", containerPort: 80 }],
                        resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
                        readinessProbe: tcpProbe("php-http"), livenessProbe: tcpProbe("php-http"),
                    },
                    {
                        name: "nginx", image: images.nginx,
                        ports: [{ name: "proxy-http", containerPort: 8080 }], resources: smallResources,
                        volumeMounts: [{ name: "nginx-config", mountPath: "/etc/nginx/nginx.conf", subPath: "nginx.conf", readOnly: true }],
                        // TCP probes keep health checks out of the HTTP request counter
                        readinessProbe: tcpProbe("proxy-http"), livenessProbe: tcpProbe("proxy-http"),
                    },
                    {
                        name: "nginx-exporter", image: images.nginxExporter,
                        args: ["--nginx.scrape-uri=http://127.0.0.1:8081/stub_status"],
                        ports: [{ name: "metrics", containerPort: 9113 }], resources: smallResources,
                        readinessProbe: tcpProbe("metrics"), livenessProbe: tcpProbe("metrics"),
                        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                    },
                ],
                volumes: [{ name: "nginx-config", configMap: { name: nginxConfig.metadata.name } }],
            },
        },
    },
}, opts);
// expose the proxy; keep metrics on separate ClusterIP services
const frontend = new k8s.core.v1.Service("frontend", {
    metadata: meta("frontend"),
    spec: { type: serviceType, selector: labels("frontend"), ports: [{ name: "http", port: 80, targetPort: "proxy-http" }] },
}, opts);
metricsService("frontend", 9113);

const prometheusSa = new k8s.core.v1.ServiceAccount("prometheus", { metadata: meta("prometheus") }, opts);
const discoveryRole = new k8s.rbac.v1.Role("prometheus-discovery", {
    metadata: meta("prometheus-discovery"),
    rules: [
        { apiGroups: [""], resources: ["pods", "services"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["get", "list", "watch"] },
    ],
}, opts);
const discoveryBinding = new k8s.rbac.v1.RoleBinding("prometheus-discovery", {
    metadata: meta("prometheus-discovery"),
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: discoveryRole.metadata.name },
    subjects: [{ kind: "ServiceAccount", name: prometheusSa.metadata.name, namespace: ns.metadata.name }],
}, opts);
const prometheusText = read("config/prometheus.yml").replace("__NAMESPACE__", namespaceName);
const prometheusConfig = new k8s.core.v1.ConfigMap("prometheus-config", {
    metadata: meta("prometheus-config"), data: { "prometheus.yml": prometheusText },
}, opts);
new k8s.apps.v1.Deployment("prometheus", {
    metadata: meta("prometheus"),
    spec: {
        replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels("prometheus") },
        template: {
            metadata: { labels: labels("prometheus"), annotations: { "checksum/config": checksum(prometheusText) } },
            spec: {
                serviceAccountName: prometheusSa.metadata.name,
                securityContext: { runAsUser: 65534, runAsGroup: 65534, fsGroup: 65534, runAsNonRoot: true },
                containers: [{
                    name: "prometheus", image: images.prometheus,
                    args: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=24h", "--storage.tsdb.retention.size=512MB"],
                    ports: [{ name: "http", containerPort: 9090 }],
                    resources: { requests: { cpu: "200m", memory: "256Mi" }, limits: { cpu: "1", memory: "768Mi" } },
                    startupProbe: { httpGet: { path: "/-/ready", port: "http" }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 60 },
                    readinessProbe: { httpGet: { path: "/-/ready", port: "http" }, timeoutSeconds: 5 },
                    livenessProbe: { httpGet: { path: "/-/healthy", port: "http" }, timeoutSeconds: 5 },
                    volumeMounts: [{ name: "config", mountPath: "/etc/prometheus", readOnly: true }, { name: "data", mountPath: "/prometheus" }],
                    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                }],
                volumes: [{ name: "config", configMap: { name: prometheusConfig.metadata.name } }, { name: "data", emptyDir: { sizeLimit: "1Gi" } }],
            },
        },
    },
}, { ...opts, dependsOn: [discoveryBinding] });
new k8s.core.v1.Service("prometheus", {
    metadata: meta("prometheus"), spec: { selector: labels("prometheus"), ports: [{ name: "http", port: 9090, targetPort: "http" }] },
}, opts);

const password = config.getSecret("grafanaAdminPassword") ?? new random.RandomPassword("grafana-admin-password", { length: 24, special: false }).result;
const adminSecret = new k8s.core.v1.Secret("grafana-admin", {
    metadata: meta("grafana-admin"), type: "Opaque", stringData: { "admin-user": "admin", "admin-password": password },
}, opts);
const grafanaData = {
    "datasources.yaml": JSON.stringify({ apiVersion: 1, datasources: [{ name: "Prometheus", uid: "prometheus", type: "prometheus", access: "proxy", url: "http://prometheus:9090", isDefault: true, editable: false, jsonData: { timeInterval: "15s" } }] }),
    "dashboards.yaml": JSON.stringify({ apiVersion: 1, providers: [{ name: "guestbook", orgId: 1, folder: "Guestbook", type: "file", disableDeletion: false, updateIntervalSeconds: 15, allowUiUpdates: true, options: { path: "/var/lib/grafana/dashboards" } }] }),
    "guestbook.json": read("dashboards/guestbook.json"),
};
const grafanaConfig = new k8s.core.v1.ConfigMap("grafana-config", { metadata: meta("grafana-config"), data: grafanaData }, opts);
new k8s.apps.v1.Deployment("grafana", {
    metadata: meta("grafana"),
    spec: {
        replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels("grafana") },
        template: {
            metadata: {
                labels: labels("grafana"),
                annotations: { "checksum/config": checksum(JSON.stringify(grafanaData)), "checksum/admin": password.apply(checksum) },
            },
            spec: {
                automountServiceAccountToken: false,
                securityContext: { runAsUser: 472, runAsGroup: 472, fsGroup: 472, runAsNonRoot: true },
                containers: [{
                    name: "grafana", image: images.grafana,
                    ports: [{ name: "http", containerPort: 3000 }],
                    env: [
                        { name: "GF_SECURITY_ADMIN_USER", valueFrom: { secretKeyRef: { name: adminSecret.metadata.name, key: "admin-user" } } },
                        { name: "GF_SECURITY_ADMIN_PASSWORD", valueFrom: { secretKeyRef: { name: adminSecret.metadata.name, key: "admin-password" } } },
                        { name: "GF_USERS_ALLOW_SIGN_UP", value: "false" },
                        { name: "GF_AUTH_ANONYMOUS_ENABLED", value: "false" },
                        { name: "GF_ANALYTICS_REPORTING_ENABLED", value: "false" },
                        { name: "GF_ANALYTICS_CHECK_FOR_UPDATES", value: "false" },
                        // the bundled datasource is enough; plugin downloads can fill the demo volume
                        { name: "GF_PLUGINS_PREINSTALL_DISABLED", value: "true" },
                        { name: "GF_PLUGINS_PREINSTALL_AUTO_UPDATE", value: "false" },
                    ],
                    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
                    startupProbe: { httpGet: { path: "/api/health", port: "http" }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 60 },
                    readinessProbe: { httpGet: { path: "/api/health", port: "http" }, timeoutSeconds: 5 },
                    livenessProbe: { httpGet: { path: "/api/health", port: "http" }, timeoutSeconds: 5 },
                    volumeMounts: [
                        { name: "data", mountPath: "/var/lib/grafana" },
                        { name: "config", mountPath: "/etc/grafana/provisioning/datasources/datasources.yaml", subPath: "datasources.yaml", readOnly: true },
                        { name: "config", mountPath: "/etc/grafana/provisioning/dashboards/dashboards.yaml", subPath: "dashboards.yaml", readOnly: true },
                        { name: "config", mountPath: "/var/lib/grafana/dashboards/guestbook.json", subPath: "guestbook.json", readOnly: true },
                    ],
                    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                }],
                volumes: [{ name: "data", emptyDir: { sizeLimit: "256Mi" } }, { name: "config", configMap: { name: grafanaConfig.metadata.name } }],
            },
        },
    },
}, opts);
const grafana = new k8s.core.v1.Service("grafana", {
    metadata: meta("grafana"),
    spec: { type: serviceType, selector: labels("grafana"), ports: [{ name: "http", port: 80, targetPort: "http" }] },
}, opts);

function accessUrl(service: k8s.core.v1.Service, localPort: number): pulumi.Output<string> {
    if (serviceType === "LoadBalancer") return service.status.apply(s => loadBalancerUrl(s.loadBalancer?.ingress));
    if (nodeAddress) {
        const host = nodeAddress.includes(":") ? `[${nodeAddress}]` : nodeAddress;
        return service.spec.apply(s => `http://${host}:${s.ports[0].nodePort}`);
    }
    return pulumi.output(`http://127.0.0.1:${localPort}`);
}
export const namespace = ns.metadata.name;
export const kubernetesContext = context;
export const grafanaUrl = accessUrl(grafana, 3000);
export const guestbookUrl = accessUrl(frontend, 8080);
export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = pulumi.secret(password);
export const accessMode = serviceType === "NodePort" && !nodeAddress ? "port-forward (run the exported commands first)" : serviceType;
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const kubectl = `kubectl --context=${shellQuote(context)} --namespace=${shellQuote(namespaceName)}`;
export const grafanaPortForward = `${kubectl} port-forward svc/grafana 3000:80`;
export const guestbookPortForward = `${kubectl} port-forward svc/frontend 8080:80`;
export const prometheusPortForward = `${kubectl} port-forward svc/prometheus 9090:9090`;
export const grafanaNodePort = grafana.spec.apply(s => s.ports[0].nodePort);
export const expectedApplicationTargets = frontendReplicas + 1 + redisReplicas;
