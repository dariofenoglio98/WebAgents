/**
 * Host permissions (T16, D-190, D-193): what the extension may reach, as Chrome grants it, and why.
 *
 * Chrome is the authority on *which* origins are granted (`chrome.permissions`); this module adds
 * the bookkeeping Chrome does not keep, *why* each origin was granted (for which package, as a
 * provider, as a site to detect agents on, for a signed document, or everywhere), in
 * `chrome.storage.local` under `originGrants`, so Settings → Permissions can list grants per
 * package and revoke them. The `PermissionsPort` is the Chrome surface the controller needs,
 * injected so the controller runs in Node (D-035).
 */
import { isRecord } from "../../core/fields.js";
import { httpsOrigin, originPattern, patternOrigin, type OriginString } from "../../core/origins.js";
import type { StorageArea } from "./settings.js";

export const ORIGIN_GRANTS_KEY = "originGrants";
/** The match pattern of "Detect agents on every site" (D-182). */
export const EVERY_SITE_PATTERN = "https://*/*";
const MAX_RECORDED_ORIGINS = 512;
const MAX_PURPOSES = 32;

export type GrantPurposeKind = "package" | "provider" | "site" | "document" | "everywhere";

export interface GrantPurpose {
  kind: GrantPurposeKind;
  /** The package id, the provider id, the site origin, the document URL, or "everywhere". */
  subject: string;
  /** A name to show (the package's name, the provider's title); the subject when absent. */
  label?: string;
}

export interface OriginGrantRecord {
  origin: OriginString;
  purposes: GrantPurpose[];
  recorded_at: string;
}

/** The Chrome surface the controller uses (`chrome.permissions`, `chrome.scripting`); memory in tests. */
export interface PermissionsPort {
  /** Whether every one of these match patterns is granted now. */
  contains(patterns: readonly string[]): Promise<boolean>;
  /** Every granted origin match pattern (`chrome.permissions.getAll().origins`). */
  granted(): Promise<string[]>;
  /** Remove these patterns; true when Chrome removed them. */
  remove(patterns: readonly string[]): Promise<boolean>;
  /** Register the discovery content script for exactly these match patterns (none unregisters it). */
  registerDiscovery(matches: readonly string[]): Promise<void>;
  /** Inject the discovery content script into one tab (`activeTab`, or a granted origin); rejects when Chrome refuses. */
  inject(tabId: number): Promise<void>;
}

/** A port over sets, for the controller's tests: grants are what the test says they are. */
export class MemoryPermissions implements PermissionsPort {
  readonly grantedPatterns = new Set<string>();
  registered: string[] = [];
  readonly injected: number[] = [];
  /** What `inject` does besides recording the tab: the test's stand-in for the content script's report. */
  onInject: ((tabId: number) => Promise<void>) | null = null;
  /** Tabs Chrome would refuse to inject into (no activeTab, no granted origin). */
  readonly unreadableTabs = new Set<number>();

  constructor(granted: readonly string[] = []) {
    for (const pattern of granted) this.grantedPatterns.add(pattern);
  }

  private covers(pattern: string): boolean {
    if (this.grantedPatterns.has(pattern)) return true;
    const origin = patternOrigin(pattern);
    return origin !== null && origin.startsWith("https://") && this.grantedPatterns.has(EVERY_SITE_PATTERN);
  }

  async contains(patterns: readonly string[]): Promise<boolean> {
    return patterns.every((pattern) => this.covers(pattern));
  }

  async granted(): Promise<string[]> {
    return [...this.grantedPatterns].sort();
  }

  async remove(patterns: readonly string[]): Promise<boolean> {
    for (const pattern of patterns) this.grantedPatterns.delete(pattern);
    return true;
  }

  async registerDiscovery(matches: readonly string[]): Promise<void> {
    this.registered = [...matches];
  }

  async inject(tabId: number): Promise<void> {
    if (this.unreadableTabs.has(tabId)) throw new Error(`Cannot access contents of the page. Extension manifest must request permission to access this host.`);
    this.injected.push(tabId);
    await this.onInject?.(tabId);
  }
}

function normalizeRecord(raw: unknown): OriginGrantRecord | null {
  if (!isRecord(raw) || typeof raw.origin !== "string" || typeof raw.recorded_at !== "string" || !Array.isArray(raw.purposes)) return null;
  const origin = raw.origin === "*" ? "*" : httpsOrigin(raw.origin);
  if (origin === null) return null;
  const purposes: GrantPurpose[] = [];
  for (const item of raw.purposes.slice(0, MAX_PURPOSES)) {
    if (!isRecord(item) || typeof item.subject !== "string" || !["package", "provider", "site", "document", "everywhere"].includes(String(item.kind))) continue;
    purposes.push({ kind: item.kind as GrantPurposeKind, subject: item.subject.slice(0, 512), ...(typeof item.label === "string" ? { label: item.label.slice(0, 200) } : {}) });
  }
  return { origin, purposes, recorded_at: raw.recorded_at };
}

/** The bookkeeping: why each origin was granted. `"*"` stands for the every-site grant. */
export class PermissionStorage {
  constructor(private readonly area: StorageArea) {}

  async all(): Promise<OriginGrantRecord[]> {
    const stored = (await this.area.get(ORIGIN_GRANTS_KEY))[ORIGIN_GRANTS_KEY];
    if (!Array.isArray(stored)) return [];
    return stored.map(normalizeRecord).filter((record): record is OriginGrantRecord => record !== null);
  }

  private async save(records: OriginGrantRecord[]): Promise<void> {
    await this.area.set({ [ORIGIN_GRANTS_KEY]: records.slice(-MAX_RECORDED_ORIGINS) });
  }

  /** Note that `origin` is granted for `purpose` (idempotent on the same kind and subject). */
  async record(origin: OriginString | "*", purpose: GrantPurpose, now: Date): Promise<void> {
    const records = await this.all();
    const existing = records.find((record) => record.origin === origin);
    if (existing) {
      const same = existing.purposes.find((item) => item.kind === purpose.kind && item.subject === purpose.subject);
      if (same) {
        if (purpose.label && same.label !== purpose.label) same.label = purpose.label;
      } else if (existing.purposes.length < MAX_PURPOSES) existing.purposes.push({ ...purpose });
    } else records.push({ origin, purposes: [{ ...purpose }], recorded_at: now.toISOString() });
    await this.save(records);
  }

  /** The origin is no longer granted (revoked here, or removed by Chrome): its record goes. */
  async forget(origin: OriginString | "*"): Promise<void> {
    await this.save((await this.all()).filter((record) => record.origin !== origin));
  }

  /**
   * Drop every record whose origin Chrome no longer grants (`permissions.onRemoved`,
   * chrome://extensions). An origin the every-site grant covers is granted, whether or not its
   * own pattern is in Chrome's list (review 1, finding 5): `permissions.request` is never sent
   * for an origin `contains` already answers for, so under the every-site grant the per-package
   * and provider records have no pattern of their own.
   */
  async reconcile(grantedPatterns: readonly string[]): Promise<void> {
    const granted = new Set(grantedPatterns);
    const everywhere = granted.has(EVERY_SITE_PATTERN);
    await this.save((await this.all()).filter((record) => (record.origin === "*" ? everywhere : everywhere || granted.has(originPattern(record.origin)))));
  }
}
