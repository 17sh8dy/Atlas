/**
 * The browser implementation of the `Platform` port.
 *
 * A browser tab cannot index your disk, enumerate installed software, or read
 * your CPU. Rather than stub those with fakes that fail at the moment of use,
 * this platform simply doesn't implement them and reports a short capability
 * list — and the engine then hides every skill that needs one.
 *
 * The result is a web build that is honestly smaller rather than subtly broken:
 * it never offers to open an app and then apologises. Everything it does list,
 * it can actually do.
 */

import type { CapabilityName, Platform } from '@atlas/core';

export function createWebPlatform(): Platform {
  return {
    id: 'web',

    capabilities: async () => {
      const caps: CapabilityName[] = [];
      // Clipboard write needs a secure context and, in some browsers, a user
      // gesture. Presence of the API is the honest signal available up front.
      if (typeof navigator !== 'undefined' && navigator.clipboard) caps.push('clipboard');
      if (typeof Notification !== 'undefined') caps.push('notifications');
      return caps;
    },

    openUrl: async (url) => {
      if (!/^https?:\/\//i.test(url)) return false;
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    },

    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },

    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    },

    notify: async (title, body) => {
      if (typeof Notification === 'undefined') return false;
      if (Notification.permission !== 'granted') {
        const granted = await Notification.requestPermission();
        if (granted !== 'granted') return false;
      }
      new Notification(title, { body });
      return true;
    },
  };
}
