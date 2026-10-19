export interface FireTvDeviceConfig {
  host: string;
  port?: number;
  dialPort?: number;
  /** TLS WebSocket audio port; independent of the remote HTTP(S) port. */
  voicePort?: number;
  name?: string;
  id?: string;
  protocol?: "http" | "https";
  rejectUnauthorized?: boolean;
  clientToken?: string;
  timeoutMs?: number;
}

export interface FireTvCredentials {
  clientToken: string;
}

export interface FireTvPairingResult {
  paired: boolean;
  status: "ok" | "bad-pin";
  credentials?: FireTvCredentials;
}

export interface FireTvPairingSession {
  submitCode(pin: string): Promise<FireTvPairingResult>;
  close(): Promise<void>;
}

export type FireTvHeldKeyName = "up" | "down" | "left" | "right" | "select";
export type FireTvKeyName =
  FireTvHeldKeyName | "back" | "home" | "menu" | "playPause" | "powerToggle";

export interface FireTvStatus {
  osVersion: string;
  platformType: string;
  turnstileVersion: string;
}

/** Reported properties are informational, not a promise of command support. */
export interface FireTvProperties {
  [property: string]: unknown;
  volumeSupport?: string;
  powerSupport?: string;
}

export interface FireTvKeyboardState {
  state: string;
  mode: string | null;
  text: string | null;
}

export interface FireTvDiscoveryResult {
  id: string;
  name: string;
  host: string;
  port: number;
  serviceName: string;
  addresses: string[];
  txt: Record<string, string | true>;
}

export interface DiscoverFireTvOptions {
  timeoutMs?: number;
  mdnsAddress?: string;
  mdnsPort?: number;
  ssdpAddress?: string;
  ssdpPort?: number;
  /** Local IPv4 addresses on which to bind discovery sockets. */
  networkInterfaces?: string[];
}
