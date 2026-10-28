import assert from "node:assert/strict";
import test from "node:test";
import { checksum, loadBalancerUrl, positiveInteger } from "../helpers";

test("helper functions validate replica counts and construct safe load balancer URLs", () => {
    assert.equal(checksum("guestbook"), "6fd1be51cc1d71785619310a02a944cf76f28e3ab000a249b0b19877efe1f288");
    assert.equal(positiveInteger(1, "replicas"), 1);
    assert.throws(() => positiveInteger(0, "replicas"), /positive integer/);
    assert.throws(() => positiveInteger(1.5, "replicas"), /positive integer/);

    assert.equal(loadBalancerUrl([{ ip: "203.0.113.10" }]), "http://203.0.113.10");
    assert.equal(loadBalancerUrl([{ hostname: "grafana.example.test" }]), "http://grafana.example.test");
    assert.equal(loadBalancerUrl([{ ip: "2001:db8::10" }]), "http://[2001:db8::10]");
    assert.throws(() => loadBalancerUrl(), /LoadBalancer address is not assigned/);
    assert.throws(() => loadBalancerUrl([{}]), /LoadBalancer address is not assigned/);
});
