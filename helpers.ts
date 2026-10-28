import { createHash } from "node:crypto";

export function checksum(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function loadBalancerUrl(ingress?: { ip?: string; hostname?: string }[]): string {
    const host = ingress?.[0]?.ip || ingress?.[0]?.hostname;
    if (!host) throw new Error("LoadBalancer address is not assigned; check the service events/cloud controller.");
    return `http://${host.includes(":") ? `[${host}]` : host}`;
}

export function positiveInteger(value: number, key: string): number {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    return value;
}
