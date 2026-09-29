export interface RoleIndexEntry {
  role: string;
  description: string;
  defaultActivity: string;
  profile: string | null;
  effort: string | null;
  model: string | null;
  resolvedBy: string | null;
  resolutionError: string | null;
  mountMode: "rw" | "ro";
  mountModeSource: string;
  settings: boolean;
  protocolSha: string | null;
  lastTaskAt: string | null;
}
export interface RolesIndexBody {
  generatedAt?: string;
  agentsDir?: string;
  generation: { id: string; root: string; sourceAssetRoot: string } | null;
  seedInstall?: { kind: string; reason: string | null };
  modelPolicy?: { source: string; path: string | null; error: string | null };
  storeError?: string | null;
  roles: RoleIndexEntry[];
}
export interface RoleIndexRow {
  role: string;
  href: string;
  description: string;
  activity: string;
  profile: string;
  mount: string;
  mountSource: string;
  lastTaskAt: string | null;
  settingsMissing: boolean;
}
export function profileLabel(role: Partial<RoleIndexEntry>): string;
export function mountLabel(mode: string | null | undefined): string;
export function rolesIndexRows(body: RolesIndexBody | null | undefined): RoleIndexRow[];
export function rolesIndexNotices(body: RolesIndexBody | null | undefined): string[];
export function rolesIndexSource(body: RolesIndexBody | null | undefined): string;
