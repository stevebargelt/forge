// System Map data transformer — takes live Task[] + PhaseShape[] and produces
// cytoscape-friendly {nodes, edges} for the task-level graph modal.
//
// Responsibility split: pure data, no DOM, no side effects. Unit-testable in
// isolation. The dashboard's html.ts owns the modal shell, ELK layout, and
// cytoscape-node-html-label rendering.

import type { Task, TaskStatus } from "../types/index.js";
import type { PhaseShape } from "./phaseShape.js";

export type TaskCyNode = {
  data: {
    id: string;          // 't:' + task.id
    label: string;       // agentAlias ?? agentRole
    phase: string;
    agentRole: string;
    status: TaskStatus;
    elapsed: string;     // '' for pending, human-readable for running/done
    isRed: boolean;      // agentRole.startsWith('red-')
    taskId: string;      // raw task.id for drag-override keying
    parentTaskId?: string; // task.parentId
    // Fanout progress: count of non-red sibling tasks in the same phase+role,
    // and how many are complete. Used by the running-fanout-node progress bar
    // in htmlLabelTpl. Always populated (0/0 for singleton phases) so the
    // template can branch on > 0 safely.
    _fanoutTotal: number;
    _fanoutComplete: number;
  };
};

export type TaskCyEdge = {
  data: {
    id: string;
    source: string;
    target: string;
    kind: "linear" | "retry" | "red";
  };
};

export type TaskGraphData = {
  nodes: TaskCyNode[];
  edges: TaskCyEdge[];
};

function formatElapsed(startedAt: string | undefined, completedAt: string | undefined, now: number): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  const ms = end - start;
  if (ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export function buildTaskGraph(tasks: Task[], _phaseShape: PhaseShape[]): TaskGraphData {
  const now = Date.now();
  const nodes: TaskCyNode[] = [];
  const edges: TaskCyEdge[] = [];

  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);

  // Fanout counts per (phase, agentRole) — non-red tasks only. A "fanout"
  // group is a set of sibling tasks for the same agent in the same phase.
  // For singleton phases the count is 1/N depending on status; for fanout
  // phases (e.g. investigate × 8) the bar shows the group's progress.
  const fanoutTotalByKey = new Map<string, number>();
  const fanoutCompleteByKey = new Map<string, number>();
  for (const t of tasks) {
    if (t.agentRole.startsWith('red-')) continue;
    const key = t.phase + '|' + t.agentRole;
    fanoutTotalByKey.set(key, (fanoutTotalByKey.get(key) ?? 0) + 1);
    if (t.status === 'complete') {
      fanoutCompleteByKey.set(key, (fanoutCompleteByKey.get(key) ?? 0) + 1);
    }
  }

  for (const t of tasks) {
    const isRed = t.agentRole.startsWith('red-');
    const key = t.phase + '|' + t.agentRole;
    nodes.push({
      data: {
        id: 't:' + t.id,
        label: t.agentAlias ?? t.agentRole,
        phase: t.phase,
        agentRole: t.agentRole,
        status: t.status,
        elapsed: formatElapsed(t.startedAt, t.completedAt, now),
        isRed,
        taskId: t.id,
        ...(t.parentId !== undefined ? { parentTaskId: t.parentId } : {}),
        _fanoutTotal: isRed ? 0 : (fanoutTotalByKey.get(key) ?? 0),
        _fanoutComplete: isRed ? 0 : (fanoutCompleteByKey.get(key) ?? 0),
      },
    });
  }

  // Build a map: phase → tasks (sorted by createdAt)
  const tasksByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!tasksByPhase.has(t.phase)) tasksByPhase.set(t.phase, []);
    tasksByPhase.get(t.phase)!.push(t);
  }

  // Linear edges: for each adjacent phase pair in phaseShape, connect
  // last non-red task in phase[i] → first non-red task in phase[i+1].
  for (let i = 0; i < _phaseShape.length - 1; i++) {
    const fromPhase = _phaseShape[i]!.name;
    const toPhase = _phaseShape[i + 1]!.name;
    const fromTasks = (tasksByPhase.get(fromPhase) || []).filter(t => !t.agentRole.startsWith('red-'));
    const toTasks = (tasksByPhase.get(toPhase) || []).filter(t => !t.agentRole.startsWith('red-'));
    if (fromTasks.length === 0 || toTasks.length === 0) continue;
    const fromTask = fromTasks[fromTasks.length - 1]!;
    const toTask = toTasks[0]!;
    edges.push({
      data: {
        id: 'e:linear:t:' + fromTask.id + '->t:' + toTask.id,
        source: 't:' + fromTask.id,
        target: 't:' + toTask.id,
        kind: 'linear',
      },
    });
  }

  // Retry edges: task.parentId → a task with same phase + same agentRole + status==='failed'
  for (const t of tasks) {
    if (!t.parentId) continue;
    const parent = taskById.get(t.parentId);
    if (!parent) continue;
    if (parent.phase === t.phase && parent.agentRole === t.agentRole && parent.status === 'failed') {
      edges.push({
        data: {
          id: 'e:retry:t:' + parent.id + '->t:' + t.id,
          source: 't:' + parent.id,
          target: 't:' + t.id,
          kind: 'retry',
        },
      });
    }
  }

  // Red edges: agentRole.startsWith('red-') && parentId set → edge parentTask→redTask
  for (const t of tasks) {
    if (!t.agentRole.startsWith('red-')) continue;
    if (!t.parentId) continue;
    const parent = taskById.get(t.parentId);
    if (!parent) continue;
    // Only emit red edge if it's not already a retry edge
    const isRetry = parent.phase === t.phase && parent.agentRole === t.agentRole && parent.status === 'failed';
    if (!isRetry) {
      edges.push({
        data: {
          id: 'e:red:t:' + parent.id + '->t:' + t.id,
          source: 't:' + parent.id,
          target: 't:' + t.id,
          kind: 'red',
        },
      });
    }
  }

  return { nodes, edges };
}

export function computeElkLayers(nodes: TaskCyNode[], phaseShape: PhaseShape[]): Map<string, number> {
  const phaseIndex = new Map<string, number>();
  for (let i = 0; i < phaseShape.length; i++) {
    phaseIndex.set(phaseShape[i]!.name, i);
  }

  const nodeById = new Map<string, TaskCyNode>();
  for (const n of nodes) nodeById.set(n.data.id, n);

  const layerMap = new Map<string, number>();
  for (const n of nodes) {
    if (!n.data.isRed) {
      layerMap.set(n.data.id, phaseIndex.get(n.data.phase) ?? 0);
    }
  }
  // Red nodes get the same layer as their parentTaskId's node
  for (const n of nodes) {
    if (n.data.isRed && n.data.parentTaskId) {
      const parentNode = nodeById.get('t:' + n.data.parentTaskId);
      if (parentNode) {
        layerMap.set(n.data.id, layerMap.get(parentNode.data.id) ?? 0);
      } else {
        layerMap.set(n.data.id, phaseIndex.get(n.data.phase) ?? 0);
      }
    } else if (n.data.isRed) {
      layerMap.set(n.data.id, phaseIndex.get(n.data.phase) ?? 0);
    }
  }

  return layerMap;
}
