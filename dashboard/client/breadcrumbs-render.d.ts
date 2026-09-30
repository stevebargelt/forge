import type { HashScope } from "./view-routing.js";

export interface Crumb {
  kind: "project" | "ticket" | "run" | "task" | "explain" | "review" | "roles" | "role" | "role-tab" | "notes" | "note";
  label: string;
  href: string | null;
}
export interface CrumbPayload {
  projectDir?: string | null;
  projectKey?: string | null;
  ticketId?: string | null;
  runId?: string | null;
  runTitle?: string | null;
  taskId?: string | null;
  taskLabel?: string | null;
  reviewId?: string | null;
}
export interface CrumbProject {
  key: string;
  label?: string;
  checkouts?: { projectDir: string }[];
}
export type ObjectPageKind = "run" | "task" | "explain" | "ticket" | "review" | "role" | "note";
export function projectForDir(projectDir: string | null | undefined, projects: CrumbProject[] | null | undefined): CrumbProject | null;
export function projectCrumb(projectDir: string | null | undefined, projects: CrumbProject[] | null | undefined, projectKey?: string | null): Crumb;
export function breadcrumbTrail(page: ObjectPageKind, payload: CrumbPayload | null | undefined, projects: CrumbProject[] | null | undefined): Crumb[];
export function parentHash(page: ObjectPageKind, payload: CrumbPayload | null | undefined, scope?: Partial<HashScope> | null): string;
export function roleTrail(role: string, tabLabel: string): Crumb[];
export function noteTrail(checkoutLabel: string, scope: Partial<HashScope> | null | undefined, projects: CrumbProject[] | null | undefined): Crumb[];
