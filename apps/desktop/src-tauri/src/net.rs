//! The network, as far as Atlas is allowed to look at it.
//!
//! ## The pattern this file is meant to demonstrate
//!
//! Phase 11 asks Atlas to cover what people use PowerShell for without
//! becoming a shell. Networking is the hardest honest case for that, because
//! Windows exposes almost none of it through an ergonomic API — the real
//! answers live behind `ipconfig` and `netsh`, which look exactly like the
//! thing this project refuses to build.
//!
//! The distinction, and it is the whole phase in one sentence: **a variable
//! command string is forbidden; a fixed one is not.** Every invocation below
//! is a compile-time constant with no interpolation of any kind. Nothing the
//! renderer says, nothing a model plans, and nothing a user types can change
//! which program runs or which arguments it gets. A reader can enumerate the
//! complete set of commands this file will ever execute by reading the three
//! constants below, which is the property `exec(command)` destroys.
//!
//! When a later skill needs a parameter — a profile name, an adapter — it goes
//! in as a *validated value in a fixed argument slot*, never as text spliced
//! into a command line.
//!
//! ## Everything here is read-only
//!
//! Nothing in this module changes the machine's networking. Reading is `safe`
//! in the risk model, so none of it prompts. Changing an adapter or forgetting
//! a Wi-Fi profile is a different file and a different risk tier, deliberately
//! not smuggled in beside the reads.

use std::process::Command;

use serde::Serialize;

/// Every command this module can run, in full.
///
/// Listed together rather than inline at each call site so that the answer to
/// "what can this thing execute?" is one short list rather than an audit.
const IPCONFIG: (&str, &[&str]) = ("ipconfig", &["/all"]);
const WLAN_INTERFACES: (&str, &[&str]) = ("netsh", &["wlan", "show", "interfaces"]);
const WLAN_PROFILES: (&str, &[&str]) = ("netsh", &["wlan", "show", "profiles"]);

#[derive(Debug, Clone, Serialize)]
pub struct NetworkAdapter {
    pub name: String,
    /// "Wi-Fi", "Ethernet", "Loopback"… as Windows describes it.
    pub kind: String,
    pub connected: bool,
    pub ipv4: Option<String>,
    pub gateway: Option<String>,
    pub mac: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WifiStatus {
    /// False when the machine has no wireless hardware at all.
    ///
    /// Distinct from `connected: false`, and the distinction matters: a
    /// desktop with an Ethernet cable should be told it has no Wi-Fi, not
    /// that its Wi-Fi is disconnected. This machine is exactly that case,
    /// which is how the difference got noticed.
    pub available: bool,
    pub connected: bool,
    pub ssid: Option<String>,
    /// 0–100, as Windows reports it.
    pub signal: Option<u8>,
    pub band: Option<String>,
    /// Receive rate in Mbps, when connected.
    pub speed: Option<String>,
}

/// Run one of the fixed commands above, treating failure as "not present".
///
/// `netsh wlan` exits 1 on a machine with no wireless service rather than
/// reporting an empty list, and that is not an error — it is an answer. The
/// caller turns `None` into "this machine has no Wi-Fi" rather than into a
/// message about Windows refusing to cooperate.
fn run_soft(command: (&str, &[&str])) -> Option<String> {
    run(command).ok()
}

/// Run one of the fixed commands above and return its stdout.
fn run(command: (&str, &[&str])) -> Result<String, String> {
    let (program, args) = command;
    let mut cmd = Command::new(program);
    cmd.args(args);

    // Without this every reading flashes a console window — the same bug that
    // made speech feel broken before it was found.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't read the network configuration: {e}"))?;
    if !out.status.success() {
        return Err("Windows wouldn't report the network configuration.".into());
    }
    // Lossy on purpose: `ipconfig` emits the console codepage, and an adapter
    // with an accented name should come back slightly wrong rather than
    // taking the whole reading down.
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The value side of an "Label . . . . : value" line, if this is one.
///
/// Both tools pad their labels with dotted leaders, so the split is on the
/// first colon rather than on any fixed column.
fn value_of(line: &str) -> Option<&str> {
    let (_, value) = line.split_once(':')?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn label_matches(line: &str, needle: &str) -> bool {
    line.split_once(':')
        .map(|(label, _)| label.to_ascii_lowercase().contains(needle))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn network_adapters() -> Result<Vec<NetworkAdapter>, String> {
    let text = tauri::async_runtime::spawn_blocking(|| run(IPCONFIG))
        .await
        .map_err(|e| format!("The network task failed: {e}"))??;
    Ok(parse_adapters(&text))
}

/// Read `ipconfig /all` output.
///
/// Separate from the command that produces it so it can be tested against
/// real output without a subprocess — the parsing is the part that breaks
/// when Windows changes a label, and the part worth pinning.
fn parse_adapters(text: &str) -> Vec<NetworkAdapter> {
    let mut adapters: Vec<NetworkAdapter> = Vec::new();
    let mut current: Option<NetworkAdapter> = None;

    for line in text.lines() {
        let trimmed = line.trim_end();

        // Adapter headers are the only unindented lines that end in a colon.
        if !trimmed.starts_with(' ') && trimmed.ends_with(':') && trimmed.len() > 1 {
            if let Some(done) = current.take() {
                adapters.push(done);
            }
            let header = trimmed.trim_end_matches(':').trim();
            // "Wireless LAN adapter Wi-Fi" → kind "Wireless LAN", name "Wi-Fi".
            let (kind, name) = match header.split_once(" adapter ") {
                Some((k, n)) => (k.trim().to_string(), n.trim().to_string()),
                None => ("Adapter".to_string(), header.to_string()),
            };
            if !name.is_empty() {
                current = Some(NetworkAdapter {
                    name,
                    kind,
                    connected: true,
                    ipv4: None,
                    gateway: None,
                    mac: None,
                });
            }
            continue;
        }

        let Some(adapter) = current.as_mut() else {
            continue;
        };

        if label_matches(trimmed, "media state") {
            // The only line that says an adapter is present but unplugged.
            adapter.connected = false;
        } else if label_matches(trimmed, "ipv4 address") {
            if let Some(v) = value_of(trimmed) {
                // "192.168.1.5(Preferred)" — the annotation is not an address.
                adapter.ipv4 = Some(v.split('(').next().unwrap_or(v).trim().to_string());
            }
        } else if label_matches(trimmed, "default gateway") {
            if let Some(v) = value_of(trimmed) {
                adapter.gateway = Some(v.to_string());
            }
        } else if label_matches(trimmed, "physical address") {
            if let Some(v) = value_of(trimmed) {
                adapter.mac = Some(v.to_string());
            }
        }
    }
    if let Some(done) = current.take() {
        adapters.push(done);
    }

    // An adapter with no address and no MAC is a header Windows printed for
    // something that is not really there — tunnelling pseudo-devices, mostly.
    adapters.retain(|a| a.ipv4.is_some() || a.mac.is_some());
    adapters
}

#[tauri::command]
pub async fn wifi_status() -> Result<WifiStatus, String> {
    let text = tauri::async_runtime::spawn_blocking(|| run_soft(WLAN_INTERFACES))
        .await
        .map_err(|e| format!("The network task failed: {e}"))?;

    let Some(text) = text else {
        return Ok(WifiStatus {
            available: false,
            connected: false,
            ssid: None,
            signal: None,
            band: None,
            speed: None,
        });
    };
    Ok(parse_wifi(&text))
}

/// Read `netsh wlan show interfaces` output.
fn parse_wifi(text: &str) -> WifiStatus {
    let mut status = WifiStatus {
        available: true,
        connected: false,
        ssid: None,
        signal: None,
        band: None,
        speed: None,
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if label_matches(trimmed, "state") && !label_matches(trimmed, "hosted") {
            if let Some(v) = value_of(trimmed) {
                status.connected = v.eq_ignore_ascii_case("connected");
            }
        // "SSID" is a prefix of "BSSID", so the negative check is not optional.
        } else if label_matches(trimmed, "ssid") && !label_matches(trimmed, "bssid") {
            status.ssid = value_of(trimmed).map(str::to_string);
        } else if label_matches(trimmed, "signal") {
            status.signal = value_of(trimmed)
                .and_then(|v| v.trim_end_matches('%').trim().parse::<u8>().ok());
        } else if label_matches(trimmed, "band") {
            status.band = value_of(trimmed).map(str::to_string);
        } else if label_matches(trimmed, "receive rate") {
            status.speed = value_of(trimmed).map(str::to_string);
        }
    }

    if !status.connected {
        status.ssid = None;
        status.signal = None;
    }
    status
}

#[tauri::command]
pub async fn wifi_networks() -> Result<Vec<String>, String> {
    let text = tauri::async_runtime::spawn_blocking(|| run_soft(WLAN_PROFILES))
        .await
        .map_err(|e| format!("The network task failed: {e}"))?;

    // No wireless service means no saved networks, which is an empty list
    // rather than a failure.
    let Some(text) = text else { return Ok(Vec::new()) };

    let mut names: Vec<String> = text
        .lines()
        .filter(|l| label_matches(l, "all user profile"))
        .filter_map(|l| value_of(l).map(str::to_string))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    Ok(names)
}

/// Is there actually a working connection?
///
/// A real request rather than a ping: what people mean by "am I online" is
/// whether things work, and a machine can answer ICMP perfectly while DNS is
/// broken or a captive portal is intercepting everything.
#[tauri::command]
pub async fn network_reachable() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Couldn't start the request: {e}"))?;

    // Microsoft's own connectivity endpoint — the one Windows itself uses, so
    // it is already allowed anywhere this machine is allowed to be.
    match client
        .get("http://www.msftconnecttest.com/connecttest.txt")
        .send()
        .await
    {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `ipconfig /all` shape, with the addresses changed.
    ///
    /// Taken from the machine this was written on — a wired desktop with no
    /// wireless — because the layout is the thing being tested and inventing
    /// it would test nothing. The MAC and IP are altered; committing someone's
    /// actual hardware address to a repository is not worth a fixture.
    const IPCONFIG_SAMPLE: &str = "\r
Windows IP Configuration\r
\r
   Host Name . . . . . . . . . . . . : DESKTOP-EXAMPLE\r
   Primary Dns Suffix  . . . . . . . :\r
   Node Type . . . . . . . . . . . . : Hybrid\r
\r
Ethernet adapter Ethernet:\r
\r
   Connection-specific DNS Suffix  . :\r
   Description . . . . . . . . . . . : Realtek PCIe GbE Family Controller\r
   Physical Address. . . . . . . . . : AA-BB-CC-DD-EE-FF\r
   DHCP Enabled. . . . . . . . . . . : Yes\r
   IPv6 Address. . . . . . . . . . . : 2605:a601:a9cf:af77::4(Preferred)\r
   Link-local IPv6 Address . . . . . : fe80::2f34:5565:6a8a:c7c9%10(Preferred)\r
   IPv4 Address. . . . . . . . . . . : 192.168.1.50(Preferred)\r
   Subnet Mask . . . . . . . . . . . : 255.255.255.0\r
   Default Gateway . . . . . . . . . : 192.168.1.1\r
\r
Ethernet adapter Ethernet 2:\r
\r
   Media State . . . . . . . . . . . : Media disconnected\r
   Description . . . . . . . . . . . : Some Virtual Adapter\r
   Physical Address. . . . . . . . . : 11-22-33-44-55-66\r
\r
Tunnel adapter Teredo Tunneling Pseudo-Interface:\r
\r
   Media State . . . . . . . . . . . : Media disconnected\r
";

    #[test]
    fn reads_a_wired_adapter() {
        let adapters = parse_adapters(IPCONFIG_SAMPLE);

        // The tunnel pseudo-interface has neither an address nor a MAC, so it
        // is dropped — it is a header Windows prints for something that is not
        // really there.
        assert_eq!(adapters.len(), 2, "{adapters:?}");

        let first = &adapters[0];
        assert_eq!(first.name, "Ethernet");
        assert_eq!(first.kind, "Ethernet");
        assert!(first.connected);
        // The "(Preferred)" annotation is not part of the address.
        assert_eq!(first.ipv4.as_deref(), Some("192.168.1.50"));
        assert_eq!(first.gateway.as_deref(), Some("192.168.1.1"));
        assert_eq!(first.mac.as_deref(), Some("AA-BB-CC-DD-EE-FF"));
    }

    #[test]
    fn an_unplugged_adapter_is_not_connected() {
        let adapters = parse_adapters(IPCONFIG_SAMPLE);
        let second = &adapters[1];
        assert_eq!(second.name, "Ethernet 2");
        assert!(!second.connected);
        assert!(second.ipv4.is_none());
    }

    #[test]
    fn the_ipv6_line_is_not_mistaken_for_ipv4() {
        // "IPv6 Address" contains "v6", not "ipv4" — but a looser match on
        // "address" would take it, and the answer to "what's my IP" would be
        // an IPv6 address nobody asked for.
        let adapters = parse_adapters(IPCONFIG_SAMPLE);
        assert_eq!(adapters[0].ipv4.as_deref(), Some("192.168.1.50"));
    }

    const WLAN_SAMPLE: &str = "\r
There is 1 interface on the system:\r
\r
    Name                   : Wi-Fi\r
    Description            : Intel Wireless-AC\r
    GUID                   : 0000\r
    Physical address       : aa:bb:cc:dd:ee:ff\r
    State                  : connected\r
    SSID                   : Example Network\r
    BSSID                  : 11:22:33:44:55:66\r
    Band                   : 5 GHz\r
    Signal                 : 84%\r
    Receive rate (Mbps)    : 780\r
";

    #[test]
    fn reads_a_connected_wifi() {
        let status = parse_wifi(WLAN_SAMPLE);
        assert!(status.available);
        assert!(status.connected);
        // ⚠️ "SSID" is a prefix of "BSSID". Without the negative check the
        // network's name comes back as a MAC address.
        assert_eq!(status.ssid.as_deref(), Some("Example Network"));
        assert_eq!(status.signal, Some(84));
        assert_eq!(status.band.as_deref(), Some("5 GHz"));
    }

    #[test]
    fn a_disconnected_wifi_reports_no_network() {
        let status = parse_wifi("    State                  : disconnected\r\n");
        assert!(status.available);
        assert!(!status.connected);
        // Stale SSID and signal would otherwise be reported as current.
        assert!(status.ssid.is_none());
        assert!(status.signal.is_none());
    }
}
