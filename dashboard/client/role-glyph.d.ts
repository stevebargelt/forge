export type RoleFamily = "red" | "build" | "test" | "review" | "research" | "plan" | "author" | "neutral";
export type GlyphShape = [string, Record<string, string | number>];
export const ROLE_FAMILIES: Readonly<Record<RoleFamily, string>>;
export const ROLE_FAMILY_OF: Readonly<Record<string, RoleFamily>>;
export const GLYPHS: Readonly<Record<string, GlyphShape[]>>;
export const ROLE_GLYPHS: Readonly<Record<string, string>>;
export const UNKNOWN_FAMILY: "neutral";
export const UNKNOWN_GLYPH: "layers";
export const TILE_SIZES: Readonly<{ row: 20; header: 36 }>;
export interface RoleTileOptions { standalone?: boolean }
export interface RoleTileSpec {
  role: string;
  family: RoleFamily;
  glyph: string;
  colour: string;
  size: number;
  radius: number;
  glyphSize: number;
  glyphOffset: number;
  strokeWidth: number;
  label: string | null;
}
export function roleFamily(role: unknown): RoleFamily;
export function roleGlyph(role: unknown): string;
export function roleTileSpec(role: unknown, size?: number, options?: RoleTileOptions): RoleTileSpec;
export function roleTileParts(spec: RoleTileSpec): {
  svg: Record<string, string | number>;
  frame: Record<string, string | number>;
  glyph: Record<string, string | number>;
  shapes: GlyphShape[];
};
export function roleTile(role: unknown, size?: number, options?: RoleTileOptions): string;
