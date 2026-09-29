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
  profileResolved: boolean;
  mountSource: string;
  lastTaskAt: string | null;
  settingsMissing: boolean;
}
export function profileLabel(role: Partial<RoleIndexEntry>): string;
export function mountLabel(mode: string | null | undefined): string;
export function rolesIndexRows(body: RolesIndexBody | null | undefined): RoleIndexRow[];
export function rolesIndexNotices(body: RolesIndexBody | null | undefined): string[];
export function rolesIndexSource(body: RolesIndexBody | null | undefined): string;
export type RoleSortColumn = "role" | "activity" | "profile" | "mount" | "lastTask";
export type RoleSortDir = "asc" | "desc";
export interface RoleSortState { column: RoleSortColumn; dir: RoleSortDir }
export const ROLE_SORT_COLUMNS: readonly RoleSortColumn[];
export const ROLE_SORT_DEFAULT: Readonly<RoleSortState>;
export function rolesSortState(params: Record<string, string> | null | undefined): RoleSortState;
export function rolesSortHash(state: RoleSortState, column: RoleSortColumn): string;
export function sortRoles(rows: RoleIndexRow[], column: string, dir: string): RoleIndexRow[];
