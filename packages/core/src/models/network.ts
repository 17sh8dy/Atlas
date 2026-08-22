/**
 * The network, as Atlas is allowed to look at it.
 *
 * Read-only, all of it. Changing an adapter or forgetting a saved network is a
 * different risk tier and is deliberately not modelled here beside the reads —
 * a type that can only describe observations cannot accidentally grow a setter.
 */

export interface NetworkAdapter {
  name: string;
  /** "Ethernet", "Wireless LAN"… as Windows describes it. */
  kind: string;
  connected: boolean;
  ipv4?: string;
  gateway?: string;
  mac?: string;
}

export interface WifiStatus {
  /**
   * False when the machine has no wireless hardware at all.
   *
   * Distinct from `connected: false`, and the distinction is the difference
   * between "your Wi-Fi is off" and "this computer has no Wi-Fi" — telling a
   * desktop user the former is just wrong.
   */
  available: boolean;
  connected: boolean;
  ssid?: string;
  /** 0-100, as Windows reports it. */
  signal?: number;
  band?: string;
  /** Receive rate, when connected. */
  speed?: string;
}
