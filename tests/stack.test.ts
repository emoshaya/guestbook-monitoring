import assert from "node:assert/strict";
import test from "node:test";
import * as pulumi from "@pulumi/pulumi";

type Resource = { type: string; name: string; inputs: Record<string, unknown> };
const resources: Resource[] = [];

function value<T>(output: pulumi.Output<T>): Promise<T> {
    return new Promise((resolve) => output.apply((result) => {
        resolve(result);
        return result;
    }));
}

test("the stack keeps metrics private and uses namespace-scoped EndpointSlice discovery", async () => {
    await pulumi.runtime.setMocks({
        newResource: (args) => {
            resources.push({ type: args.type, name: args.name, inputs: args.inputs });
            const state = { ...args.inputs };
            if (args.type === "random:index/randomPassword:RandomPassword") {
                state.result = "generated-admin-password";
            }
            if (args.type === "kubernetes:core/v1:Service") {
                state.status = { loadBalancer: { ingress: [{ hostname: "lb.example.test" }] } };
            }
            return { id: `${args.name}_id`, state };
        },
        call: () => ({}),
    }, "guestbook-monitoring", "dev");
    pulumi.runtime.setAllConfig({
        "guestbook-monitoring:kubernetesContext": "unit-test-cluster",
        "guestbook-monitoring:serviceType": "LoadBalancer",
    });

    const stack = await import("../index");
    assert.equal(await value(stack.grafanaUrl), "http://lb.example.test");
    assert.equal(await value(stack.guestbookUrl), "http://lb.example.test");
    assert.equal(await pulumi.isSecret(stack.grafanaAdminPassword), true);
    assert.equal(stack.expectedApplicationTargets, 6);
    assert.equal(stack.grafanaPortForward, "kubectl --context='unit-test-cluster' --namespace='guestbook-dev' port-forward svc/grafana 3000:80");
    assert.equal(stack.guestbookPortForward, "kubectl --context='unit-test-cluster' --namespace='guestbook-dev' port-forward svc/frontend 8080:80");
    assert.equal(stack.prometheusPortForward, "kubectl --context='unit-test-cluster' --namespace='guestbook-dev' port-forward svc/prometheus 9090:9090");
    await new Promise((resolve) => setImmediate(resolve));
    await pulumi.runtime.awaitStackRegistrations();

    const byName = (name: string) => {
        const item = resources.find((resource) => resource.name === name);
        assert.ok(item, `expected resource ${name}`);
        return item;
    };
    const frontendService = byName("frontend");
    const frontendSpec = frontendService.inputs.spec as { type: string; ports: Array<{ targetPort: string }> };
    assert.equal(frontendSpec.type, "LoadBalancer");
    assert.deepEqual(frontendSpec.ports, [{ name: "http", port: 80, targetPort: "proxy-http" }]);

    for (const name of ["frontend-metrics", "redis-leader-metrics", "redis-replica-metrics"]) {
        const service = byName(name);
        const metadata = service.inputs.metadata as { annotations: Record<string, string> };
        const spec = service.inputs.spec as { type: string; ports: Array<{ name: string; targetPort: string }> };
        assert.equal(spec.type, "ClusterIP");
        assert.equal(spec.ports[0].name, "metrics");
        assert.equal(spec.ports[0].targetPort, "metrics");
        assert.equal(metadata.annotations["prometheus.io/scrape"], "true");
        assert.equal(metadata.annotations["prometheus.io/path"], "/metrics");
    }

    const frontendDeployment = resources.find((resource) => resource.type === "kubernetes:apps/v1:Deployment" && resource.name === "frontend");
    assert.ok(frontendDeployment, "expected frontend deployment");
    const frontendContainers = ((frontendDeployment.inputs.spec as any).template.spec.containers as Array<{ name: string; ports?: Array<{ name: string; containerPort: number }>; args?: string[] }>);
    const nginxExporter = frontendContainers.find((container) => container.name === "nginx-exporter");
    assert.deepEqual(nginxExporter?.args, ["--nginx.scrape-uri=http://127.0.0.1:8081/stub_status"]);
    assert.deepEqual(nginxExporter?.ports, [{ name: "metrics", containerPort: 9113 }]);
    for (const redisName of ["redis-leader", "redis-replica"]) {
        const deployment = resources.find((resource) => resource.type === "kubernetes:apps/v1:Deployment" && resource.name === redisName);
        assert.ok(deployment, `expected ${redisName} deployment`);
        const containers = ((deployment.inputs.spec as any).template.spec.containers as Array<{ name: string; args?: string[] }>);
        assert.deepEqual(containers.find((container) => container.name === "redis-exporter")?.args, ["--redis.addr=redis://127.0.0.1:6379"]);
    }

    const roles = resources.filter((resource) => resource.type.includes("rbac.authorization.k8s.io"));
    assert.deepEqual(roles.map((resource) => resource.type).sort(), ["kubernetes:rbac.authorization.k8s.io/v1:Role", "kubernetes:rbac.authorization.k8s.io/v1:RoleBinding"]);
    const roleRules = (byName("prometheus-discovery").inputs.rules as Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>);
    assert.deepEqual(roleRules, [
        { apiGroups: [""], resources: ["pods", "services"], verbs: ["get", "list", "watch"] },
        { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["get", "list", "watch"] },
    ]);

    const prometheusConfig = byName("prometheus-config");
    const config = (prometheusConfig.inputs.data as Record<string, string>)["prometheus.yml"];
    assert.match(config, /role: endpointslice/);
    assert.match(config, /names: \[guestbook-dev\]/);
    assert.match(config, /__meta_kubernetes_endpointslice_port_name/);
    assert.match(config, /regex: metrics/);
    assert.match(config, /__meta_kubernetes_endpointslice_endpoint_conditions_ready/);
    assert.doesNotMatch(config, /static_configs:\n\s+- targets: \[.*(?:9113|9121)/);

    const grafana = resources.find((resource) => resource.type === "kubernetes:apps/v1:Deployment" && resource.name === "grafana");
    assert.ok(grafana, "expected grafana deployment");
    const grafanaContainers = ((grafana.inputs.spec as any).template.spec.containers as Array<{ name: string; env: Array<any> }>);
    const env = grafanaContainers.find((container) => container.name === "grafana")?.env ?? [];
    const password = env.find((entry) => entry.name === "GF_SECURITY_ADMIN_PASSWORD");
    assert.equal(password.valueFrom.secretKeyRef.key, "admin-password");
    assert.ok(password.valueFrom.secretKeyRef.name);
});
