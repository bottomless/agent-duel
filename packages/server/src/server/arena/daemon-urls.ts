import { BlockList, type AddressInfo } from "node:net";

interface ArenaDaemonUrls {
  runtimeBaseUrl: string | null;
  previewBaseUrl: string;
}

export type GetArenaDaemonUrls = () => ArenaDaemonUrls | null;

// Node's range check also recognizes IPv4-mapped IPv6 loopback addresses.
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function runtimeBaseUrl({ address, family, port }: AddressInfo): string | null {
  if (family === "IPv4") {
    const host = address === "0.0.0.0" ? "127.0.0.1" : address;
    if (loopback.check(host, "ipv4")) return `http://${host}:${port}`;
  }
  if (family === "IPv6") {
    const host = address === "::" ? "::1" : address;
    if (loopback.check(host, "ipv6")) return `http://[${host}]:${port}`;
  }
  return null;
}

/** Only the runtime carries a capability; browser previews replace the hostname per side. */
export function arenaDaemonUrls(address: AddressInfo | string | null): ArenaDaemonUrls | null {
  if (address === null || typeof address === "string") return null;
  return {
    runtimeBaseUrl: runtimeBaseUrl(address),
    previewBaseUrl: `http://localhost:${address.port}`,
  };
}
