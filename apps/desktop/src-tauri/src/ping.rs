//! Ping — four ICMP echoes to a host, through the Win32 ICMP API directly.
//!
//! Not `ping.exe`: a direct call gives structured results (which of the four
//! came back, and how fast) without parsing a localised program's output, and
//! there is no command line for a host name to be smuggled into. The host is
//! still checked — letters, digits, dots and hyphens only — because it is the
//! one free-text value, and because a name that is not a name should be
//! refused before anything is sent to anyone.

#![cfg(windows)]

use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};

use serde::Serialize;
use windows::Win32::NetworkManagement::IpHelper::{
    IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY,
};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    /// The address that was pinged (a name is resolved first).
    pub address: String,
    pub sent: u32,
    pub received: u32,
    /// Round trip in milliseconds, per reply that came back.
    pub times_ms: Vec<u32>,
}

/// A hostname or IPv4 address, and nothing that could be anything else.
pub(crate) fn is_plain_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
        && !host.contains("..")
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn resolve_v4(host: &str) -> Result<Ipv4Addr, String> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    (host, 0u16)
        .to_socket_addrs()
        .map_err(|_| format!("I couldn't find “{host}” — is the name right?"))?
        .find_map(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| format!("“{host}” has no IPv4 address I can ping."))
}

fn ping_blocking(host: &str) -> Result<PingResult, String> {
    if !is_plain_host(host) {
        return Err("That doesn't look like a host name or address.".into());
    }
    let ip = resolve_v4(host)?;
    // Network byte order: the octets as they read, in memory order.
    let dest = u32::from_le_bytes(ip.octets());
    let payload = [0x61u8; 32];
    let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];

    let handle = unsafe { IcmpCreateFile() }.map_err(|e| e.message())?;
    let mut times = Vec::new();
    let sent = 4u32;
    for i in 0..sent {
        if crate::halt::global().check().is_err() {
            break;
        }
        let n = unsafe {
            IcmpSendEcho(
                handle,
                dest,
                payload.as_ptr() as *const _,
                payload.len() as u16,
                None,
                reply.as_mut_ptr() as *mut _,
                reply.len() as u32,
                2000,
            )
        };
        if n > 0 {
            let r = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
            // Status 0 is IP_SUCCESS; anything else (unreachable, TTL expired) is a non-reply.
            if r.Status == 0 {
                times.push(r.RoundTripTime);
            }
        }
        if i + 1 < sent {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    unsafe {
        let _ = IcmpCloseHandle(handle);
    }
    Ok(PingResult { address: ip.to_string(), sent, received: times.len() as u32, times_ms: times })
}

#[tauri::command]
pub async fn ping_host(host: String) -> Result<PingResult, String> {
    crate::halt::global().check()?;
    let host = host.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || ping_blocking(&host))
        .await
        .map_err(|e| format!("Ping failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_hosts_are_accepted() {
        for good in ["google.com", "8.8.8.8", "my-server", "a.b.c.d.example.org"] {
            assert!(is_plain_host(good), "{good}");
        }
        for bad in ["", "a b", "a;b", "a&b", "-x", "x-", ".x", "x.", "a..b", "a/b", "a\\b", "a$b", "http://x"] {
            assert!(!is_plain_host(bad), "{bad}");
        }
    }

    #[test]
    fn a_bad_host_is_refused_before_anything_is_sent() {
        assert!(ping_blocking("a;b").is_err());
        assert!(ping_blocking("").is_err());
    }

    /// Live: the loopback address always answers, with no network at all.
    #[test]
    fn loopback_answers() {
        let r = ping_blocking("127.0.0.1").unwrap();
        assert_eq!(r.sent, 4);
        assert!(r.received >= 1, "loopback should answer: {r:?}");
        eprintln!("{r:?}");
    }
}
