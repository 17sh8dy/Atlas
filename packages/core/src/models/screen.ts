/**
 * Screen capture and display information — the last-resort "look at the
 * screen" layer, reached for only once a Windows API or UI Automation can't
 * answer the question.
 */

export interface DisplayInfo {
  /** The device name Windows uses internally, e.g. "\\\\.\\DISPLAY1". */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The monitor's work area — its bounds minus the taskbar. */
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  primary: boolean;
  dpi: number;
}
