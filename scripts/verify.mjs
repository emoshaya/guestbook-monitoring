// run with the three port forwards from the readme
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = process.env.GUESTBOOK_URL || "http://127.0.0.1:8080";
const prometheus = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";
const grafana = process.env.GRAFANA_URL || "http://127.0.0.1:3000";
const expected = Number(process.env.EXPECTED_TARGETS || 6);
const password = process.env.GRAFANA_PASSWORD;
assert.ok(Number.isInteger(expected) && expected >= 3, "EXPECTED_TARGETS must be an integer >= 3");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, `HTTP ${response.status} for ${new URL(url).pathname}`);
    return response.json();
}
async function query(expr) {
    const result = await json(`${prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`);
    assert.equal(result.status, "success", `PromQL query failed: ${expr}`);
    return result.data.result;
}
async function eventually(label, fn, attempts = 24) {
    let error;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); } catch (e) { error = e; }
        if (i < attempts - 1) await pause(5000);
    }
    throw new Error(`${label}: ${error.message}`);
}

const targets = await eventually("Waiting for all application scrape targets", async () => {
    const data = await json(`${prometheus}/api/v1/targets`);
    const targets = data.data.activeTargets.filter(t => t.labels.job === "guestbook");
    assert.equal(targets.length, expected, `Expected ${expected} application targets, found ${targets.length}`);
    for (const target of targets) {
        assert.equal(target.health, "up", `${target.labels.component}/${target.labels.pod}: ${target.lastError}`);
        assert.ok(target.labels.pod && target.labels.namespace, "Missing pod/namespace labels");
    }
    for (const component of ["frontend", "redis-leader", "redis-replica"]) {
        assert.ok(targets.some(t => t.labels.component === component), `Missing ${component}`);
    }
    assert.equal(new Set(targets.map(t => t.scrapeUrl)).size, expected, "Duplicate scrape targets");
    return targets;
});
console.log(`PASS: ${targets.length} unique frontend/backend pod targets are up`);

for (const metric of ["nginx_up", "redis_up"]) {
    const samples = await query(`${metric}{job="guestbook"}`);
    const count = targets.filter(t => metric === "nginx_up" ? t.labels.component === "frontend" : t.labels.component.startsWith("redis-")).length;
    assert.equal(samples.length, count, `${metric} missing some application pods`);
    assert.ok(samples.every(s => Number(s.value[1]) === 1), `${metric} reports an unhealthy application`);
}
console.log("PASS: exporters can reach NGINX and Redis (not just their HTTP endpoints)");

const before = Number((await query('sum(nginx_http_requests_total{job="guestbook"})'))[0]?.value[1]);
assert.ok(Number.isFinite(before), "Frontend request counter missing");
const value = `monitoring-${Date.now()}`;
const set = new URL("/guestbook.php", app);
set.search = new URLSearchParams({ cmd: "set", key: "monitoring-verification", value }).toString();
assert.equal((await json(set)).message, "Updated");
const get = new URL("/guestbook.php", app);
get.search = new URLSearchParams({ cmd: "get", key: "monitoring-verification" }).toString();
await eventually("Redis replication/read path", async () => assert.equal((await json(get)).data, value));
for (let i = 0; i < 50; i++) await json(get);
console.log("PASS: Guestbook writes to leader and reads replicated data; generated 50 requests");

await eventually("Frontend counter increment", async () => {
    const after = Number((await query('sum(nginx_http_requests_total{job="guestbook"})'))[0]?.value[1]);
    assert.ok(after - before >= 50, `Counter increased by ${after - before}, expected >= 50`);
});
for (const metric of ["redis_memory_used_bytes", "redis_commands_processed_total"]) {
    const values = await query(`${metric}{job="guestbook"}`);
    assert.ok(values.length > 0 && values.every(s => Number(s.value[1]) > 0), `${metric} missing/empty`);
}
console.log("PASS: frontend counters increased; Redis memory and command metrics exist");

const health = await json(`${grafana}/api/health`);
assert.equal(health.database, "ok");
if (password) {
    const headers = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` };
    const ds = await json(`${grafana}/api/datasources/uid/prometheus`, { headers });
    assert.equal(ds.type, "prometheus");
    const dsHealth = await json(`${grafana}/api/datasources/uid/prometheus/health`, { headers });
    assert.equal(dsHealth.status, "OK");
    const dashboard = await json(`${grafana}/api/dashboards/uid/guestbook-overview`, { headers });
    assert.equal(dashboard.dashboard.title, "Guestbook Overview");
    console.log("PASS: Grafana admin login, provisioned dashboard and working Prometheus datasource");
} else {
    console.log("PASS: Grafana health; SKIPPED authenticated dashboard/datasource checks (set GRAFANA_PASSWORD)");
}

// check each dashboard query against the deployed namespace
const dashboard = JSON.parse(readFileSync(new URL("../dashboards/guestbook.json", import.meta.url), "utf8"));
const namespace = targets[0].labels.namespace;
for (const panel of dashboard.panels) {
    for (const target of panel.targets || []) {
        if (!target.expr) continue;
        const expression = target.expr.replace(/\$\{namespace\}|\$namespace/g, namespace).replace(/\$__rate_interval/g, "1m");
        await eventually(`Dashboard query: ${panel.title}`, async () => {
            const samples = await query(expression);
            assert.ok(samples.length > 0, "No data");
            assert.ok(samples.every(s => Number.isFinite(Number(s.value[1]))), "Non-finite values");
        });
    }
}
console.log("PASS: every dashboard panel query returns data");
