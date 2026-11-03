import { hubStructure } from "@kan/builderspace/structure";

import type { Db } from "../db";
import type { TaskRow, ViewableProject } from "../kan/tasks.gateway";
import type {
  DueState,
  FunctionKey,
  Stage,
  TaskView,
  TileCounts,
} from "./task.policy";
import {
  listBoardsWithLists,
  listTaskRows,
  listViewableProjects,
} from "../kan/tasks.gateway";
import { HubError } from "../shared/errors";
import {
  columnsOf,
  countTiles,
  DONE_COLUMN_LIMIT,
  dueStateOf,
  functionKeyOf,
  functionKeys,
  isOpen,
  missingListIndex,
  onBoard,
  stageOf,
  stages,
} from "./task.policy";

/**
 * The home page and the cross-project task board.
 *
 * Both are scoped to "全部" (every project the person can see) or to one of
 * those projects. Projects they cannot see never appear: not in the switcher,
 * not in a count, not on the board.
 */

export interface ProjectChip {
  publicId: string;
  name: string;
}

export interface Task {
  publicId: string;
  title: string;
  dueDate: Date | null;
  dueState: DueState;
  stage: Stage;
  functionKey: FunctionKey | null;
  project: ProjectChip;
  board: { publicId: string; name: string };
  listName: string;
  labels: { name: string; colourCode: string | null }[];
  /** Display names of the people the task is assigned to. */
  assignees: string[];
  assignedToMe: boolean;
}

export interface Scope {
  /** Every project the person can see, in the team's order. */
  projects: ProjectChip[];
  /** The project being looked at, or null for 全部. */
  current: ProjectChip | null;
}

export interface HomeSummary {
  scope: Scope;
  tiles: TileCounts;
  /** Open tasks assigned to me, soonest due first. */
  myTasks: Task[];
}

export interface TaskColumn {
  stage: Stage;
  tasks: Task[];
  /** How many tasks are in the column, including any left out by the limit. */
  total: number;
}

/** What the person may do with tasks in one project of the scope. */
export interface ProjectAccess {
  canCreate: boolean;
  canEdit: boolean;
  /**
   * May add a list to a board: moving a task into a column its board has no
   * list for adds that list first.
   */
  canAddLists: boolean;
  /** Their membership, for assigning a new task to themselves. */
  memberPublicId: string;
}

/**
 * A board a task can be moved within or created on, with the list that stands
 * for each standard column. A column the board has no list for is missing.
 */
export interface BoardTarget {
  publicId: string;
  name: string;
  functionKey: FunctionKey | null;
  project: ProjectChip;
  listsByStage: Partial<Record<Exclude<Stage, "other">, string>>;
  /**
   * For a column the board has no list for: the index a new list takes so it
   * sits in column order (`missingListIndex`). Absent means the end.
   */
  newListIndex: Partial<Record<Exclude<Stage, "other">, number>>;
}

export interface TaskBoard {
  scope: Scope;
  view: TaskView;
  /** 只看我的: only tasks assigned to me are on the board and in the totals. */
  onlyMine: boolean;
  columns: TaskColumn[];
  /** Keyed by project public id; only projects in scope. */
  access: Record<string, ProjectAccess>;
  /** Standard functions first, in the team's order, then other boards. */
  boards: BoardTarget[];
}

/** A task plus the date it is ordered by; never leaves this module. */
type LoadedTask = Task & { sortDate: Date };

function publicTask({ sortDate: _sortDate, ...task }: LoadedTask): Task {
  return task;
}

/** How many of my tasks the home page lists before "查看全部". */
export const HOME_MY_TASKS_LIMIT = 6;

interface ScopeInput {
  userId: string;
  /** A project's public id, or undefined for 全部. */
  projectPublicId?: string;
  now: Date;
}

export async function getHome(db: Db, input: ScopeInput): Promise<HomeSummary> {
  const { scope, tasks } = await loadScope(db, input);
  const open = tasks.filter((task) => isOpen(task.stage));

  return {
    scope,
    tiles: countTiles(tasks),
    myTasks: open
      .filter((task) => task.assignedToMe)
      .sort(bySoonestDue)
      .slice(0, HOME_MY_TASKS_LIMIT)
      .map(publicTask),
  };
}

/**
 * Every task assigned to this person in the projects they can see, finished
 * ones included. The personal calendar plans against this list, so a task they
 * were taken off or a project they left drops out of it.
 */
export async function getMyTasks(
  db: Db,
  input: { userId: string; now: Date },
): Promise<Task[]> {
  return (await getVisibleTasks(db, input)).filter((task) => task.assignedToMe);
}

/**
 * Every task in every project this person can see, whoever it belongs to.
 * "我完成的" needs it to credit unassigned tasks to whoever finished them.
 */
export async function getVisibleTasks(
  db: Db,
  input: { userId: string; now: Date },
): Promise<Task[]> {
  const { tasks } = await loadScope(db, input);
  return tasks.map(publicTask);
}

export async function getTaskBoard(
  db: Db,
  input: ScopeInput & { view: TaskView; onlyMine?: boolean },
): Promise<TaskBoard> {
  const { scope, tasks, inScope } = await loadScope(db, input);
  const onlyMine = input.onlyMine ?? false;
  const onThisBoard = tasks.filter((task) =>
    onBoard(task, input.view, onlyMine),
  );

  const columns = columnsOf(input.view)
    .map((stage) => {
      const all = onThisBoard.filter((task) => task.stage === stage);
      return stage === "done"
        ? {
            stage,
            tasks: all
              .sort(byMostRecent)
              .slice(0, DONE_COLUMN_LIMIT)
              .map(publicTask),
            total: all.length,
          }
        : {
            stage,
            tasks: all.sort(bySoonestDue).map(publicTask),
            total: all.length,
          };
    })
    .filter((column) => column.stage !== "other" || column.total > 0);

  const chips = new Map(inScope.map((p) => [p.id, toChip(p)]));
  const boards = (
    await listBoardsWithLists(
      db,
      inScope.map((project) => project.id),
      input.userId,
    )
  ).flatMap((board) => {
    const project = chips.get(board.projectId);
    if (!project) return [];
    const listsByStage: BoardTarget["listsByStage"] = {};
    const newListIndex: BoardTarget["newListIndex"] = {};
    for (const list of board.lists) {
      const stage = stageOf(list.name);
      if (stage !== "other") listsByStage[stage] ??= list.publicId;
    }
    for (const stage of stages) {
      if (stage === "other" || listsByStage[stage]) continue;
      const index = missingListIndex(board.lists, stage);
      if (index !== undefined) newListIndex[stage] = index;
    }
    return [
      {
        publicId: board.publicId,
        name: board.name,
        functionKey: functionKeyOf(board.name),
        project,
        listsByStage,
        newListIndex,
      },
    ];
  });

  return {
    scope,
    view: input.view,
    onlyMine,
    columns,
    access: Object.fromEntries(
      inScope.map((project) => [
        project.publicId,
        {
          canCreate: project.canCreateTasks,
          canEdit: project.canEditTasks,
          canAddLists: project.canCreateLists,
          memberPublicId: project.memberPublicId,
        },
      ]),
    ),
    boards: boards.sort(byTeamOrder(inScope)),
  };
}

async function loadScope(
  db: Db,
  input: ScopeInput,
): Promise<{
  scope: Scope;
  tasks: LoadedTask[];
  inScope: ViewableProject[];
}> {
  const viewable = orderProjects(await listViewableProjects(db, input.userId));
  const current = input.projectPublicId
    ? viewable.find((p) => p.publicId === input.projectPublicId)
    : undefined;
  if (input.projectPublicId && !current) {
    // The same answer whether the project does not exist or is not theirs.
    throw new HubError("NOT_FOUND", "没有这个项目，或者你不在这个项目里。");
  }

  const inScope = current ? [current] : viewable;
  const rows = await listTaskRows(
    db,
    inScope.map((project) => project.id),
    input.userId,
  );
  const chips = new Map(inScope.map((p) => [p.id, toChip(p)]));

  return {
    inScope,
    scope: {
      projects: viewable.map(toChip),
      current: current ? toChip(current) : null,
    },
    tasks: rows.flatMap((row) => {
      const project = chips.get(row.projectId);
      return project ? [toTask(row, project, input.userId, input.now)] : [];
    }),
  };
}

function toTask(
  row: TaskRow,
  project: ProjectChip,
  userId: string,
  now: Date,
): LoadedTask {
  return {
    publicId: row.publicId,
    title: row.title,
    dueDate: row.dueDate,
    dueState: dueStateOf(row.dueDate, now),
    stage: stageOf(row.listName),
    functionKey: functionKeyOf(row.boardName),
    project,
    board: { publicId: row.boardPublicId, name: row.boardName },
    listName: row.listName,
    labels: row.labels,
    assignees: row.assignees.map((assignee) => assignee.name),
    assignedToMe: row.assignees.some((assignee) => assignee.userId === userId),
    sortDate: row.updatedAt ?? row.createdAt,
  };
}

/** The team's projects in the order of the shared structure, then the rest by name. */
function orderProjects(projects: ViewableProject[]): ViewableProject[] {
  const rank = (project: ViewableProject) => {
    const index = hubStructure.projects.findIndex(
      (p) => p.slug === project.slug,
    );
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...projects].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-CN"),
  );
}

/** Boards in project order, then 技术 / 活动 / 运营, then the rest by name. */
function byTeamOrder(projects: readonly ViewableProject[]) {
  const projectRank = new Map(projects.map((p, index) => [p.publicId, index]));
  const functionRank = (key: FunctionKey | null) =>
    key === null ? functionKeys.length : functionKeys.indexOf(key);
  return (a: BoardTarget, b: BoardTarget) =>
    (projectRank.get(a.project.publicId) ?? 0) -
      (projectRank.get(b.project.publicId) ?? 0) ||
    functionRank(a.functionKey) - functionRank(b.functionKey) ||
    a.name.localeCompare(b.name, "zh-CN");
}

function toChip(project: ViewableProject): ProjectChip {
  return { publicId: project.publicId, name: project.name };
}

/** Due date first (no due date last), then oldest first so nothing starves. */
function bySoonestDue(a: LoadedTask, b: LoadedTask) {
  const dueA = a.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const dueB = b.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  return dueA - dueB || a.sortDate.getTime() - b.sortDate.getTime();
}

function byMostRecent(a: { sortDate: Date }, b: { sortDate: Date }) {
  return b.sortDate.getTime() - a.sortDate.getTime();
}
