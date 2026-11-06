import { useCallback, useRef, useState } from "react";

import type { Stage, TaskView } from "@kan/hub/public";
import { stageNames } from "@kan/hub/public";

import type { WhatIsLeft } from "./DoneToast";
import type { HubTask } from "./task-display";
import type { Notice } from "./UndoToast";
import type { RouterOutputs } from "~/utils/api";
import { copy } from "~/hub/copy/zh";
import {
  withTaskDue,
  withTaskMoved,
  withTaskRemoved,
} from "~/hub/lib/board-cache";
import { api } from "~/utils/api";

type Board = RouterOutputs["hub"]["tasks"]["board"];
type BoardTarget = Board["boards"][number];
type ListStage = Exclude<Stage, "other">;

const text = copy.tasks;

/** How many of my remaining tasks the toast lists after I finish one. */
const DONE_TOAST_NEXT = 3;

const listKey = (boardPublicId: string, stage: ListStage) =>
  `${boardPublicId}:${stage}`;

export interface NewTask {
  title: string;
  boardPublicId: string;
  stage: Exclude<Stage, "other">;
  dueDate: Date | null;
  assignToMe: boolean;
}

/**
 * Everything the overall board can change, written through Kan's own card
 * and list API: the card is the same one its board shows, Kan checks the
 * permission and records the activity. 归档 is the Hub's own, so it goes
 * through `hub.tasks`. The board updates at once and is refreshed from the
 * server afterwards, as are the home page and 归档.
 *
 * A board someone set up themselves may have no list for a column (no 待验收,
 * say). Moving a task there adds that list to its board first, in column
 * order, for anyone Kan lets add lists.
 */
export function useBoardActions(
  board: Board | undefined,
  query: { view: TaskView; project?: string },
) {
  const utils = api.useUtils();
  const updateCard = api.card.update.useMutation();
  const createCard = api.card.create.useMutation();
  const deleteCard = api.card.delete.useMutation();
  const archiveTask = api.hub.tasks.archive.useMutation();
  const restoreTask = api.hub.tasks.restore.useMutation();
  const createList = api.list.create.useMutation();
  const updateList = api.list.update.useMutation();
  // Lists being added, until the board reloads with them, so a second task
  // dropped in the same column meanwhile lands in the same new list.
  const addedLists = useRef(new Map<string, Promise<string>>());
  const [error, setError] = useState<string | null>(null);
  const [doneToast, setDoneToast] = useState<WhatIsLeft | null>(null);
  const dismissDoneToast = useCallback(() => setDoneToast(null), []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const refresh = () =>
    Promise.all([
      utils.hub.tasks.board.invalidate(),
      utils.hub.tasks.home.invalidate(),
      utils.hub.tasks.archived.invalidate(),
    ]);

  const targetOf = (boardPublicId: string) =>
    board?.boards.find((candidate) => candidate.publicId === boardPublicId);

  /** The list that stands for `stage` on a board that has none, added now. */
  function addListFor(target: BoardTarget, stage: ListStage): Promise<string> {
    const key = listKey(target.publicId, stage);
    const pending = addedLists.current.get(key);
    if (pending) return pending;

    const adding = (async () => {
      const list = await createList.mutateAsync({
        boardPublicId: target.publicId,
        name: stageNames[stage],
      });
      const index = target.newListIndex[stage];
      if (index !== undefined) {
        // Kan adds a list on the end; this puts it in column order. Where it
        // sits is cosmetic, so a refusal here does not stop the move.
        await updateList
          .mutateAsync({ listPublicId: list.publicId, index })
          .catch(() => undefined);
      }
      return list.publicId;
    })();
    addedLists.current.set(key, adding);
    // A failed attempt is not remembered, so the next drop tries again.
    adding.catch(() => addedLists.current.delete(key));
    return adding;
  }

  async function move(task: HubTask, to: Stage): Promise<void> {
    if (to === task.stage || to === "other") return;
    const target = targetOf(task.board.publicId);
    const existing = target?.listsByStage[to];
    const mayAddList =
      !!target && !!board?.access[target.project.publicId]?.canAddLists;
    if (!target) {
      setError(text.move.noList(task.board.name, stageNames[to]));
      return;
    }
    if (!existing && !mayAddList) {
      setError(text.move.cannotAddList(task.board.name, stageNames[to]));
      return;
    }

    setError(null);
    utils.hub.tasks.board.setData(query, (old) =>
      old ? withTaskMoved(old, task.publicId, to, stageNames[to]) : old,
    );
    try {
      await updateCard.mutateAsync({
        cardPublicId: task.publicId,
        listPublicId: existing ?? (await addListFor(target, to)),
      });
      if (to === "done") void showWhatIsLeft();
    } catch {
      setError(text.move.failed);
    } finally {
      void refresh().then(() => {
        if (!existing) addedLists.current.delete(listKey(target.publicId, to));
      });
    }
  }

  /** My open tasks across every project, fetched fresh once the move landed. */
  async function showWhatIsLeft(): Promise<void> {
    const home = await utils.hub.tasks.home
      .fetch({}, { staleTime: 0 })
      .catch(() => null);
    if (!home) return;
    setDoneToast({
      left: home.tiles.mine,
      next: home.myTasks.slice(0, DONE_TOAST_NEXT).map((t) => t.title),
    });
  }

  async function setDue(task: HubTask, dueDate: Date | null): Promise<void> {
    setError(null);
    utils.hub.tasks.board.setData(query, (old) =>
      old ? withTaskDue(old, task.publicId, dueDate) : old,
    );
    try {
      await updateCard.mutateAsync({ cardPublicId: task.publicId, dueDate });
    } catch {
      setError(text.dueFailed);
    } finally {
      void refresh();
    }
  }

  /** Takes the task off every board into 归档, with 撤销 for a while. */
  async function archive(task: HubTask): Promise<void> {
    setError(null);
    setNotice(null);
    utils.hub.tasks.board.setData(query, (old) =>
      old ? withTaskRemoved(old, task.publicId) : old,
    );
    try {
      await archiveTask.mutateAsync({ cardPublicId: task.publicId });
      setNotice({
        message: text.archived.moved,
        undo: () => void restore(task),
      });
    } catch {
      setError(text.archived.archiveFailed);
    } finally {
      void refresh();
    }
  }

  async function restore(task: HubTask): Promise<void> {
    setNotice(null);
    try {
      await restoreTask.mutateAsync({ cardPublicId: task.publicId });
    } catch {
      setError(text.archived.restoreFailed);
    } finally {
      void refresh();
    }
  }

  /** Deletes the task through Kan, as its own card page would. */
  async function remove(task: HubTask): Promise<void> {
    setError(null);
    setNotice(null);
    utils.hub.tasks.board.setData(query, (old) =>
      old ? withTaskRemoved(old, task.publicId) : old,
    );
    try {
      await deleteCard.mutateAsync({ cardPublicId: task.publicId });
      setNotice({ message: text.archived.deleted });
    } catch {
      setError(text.archived.deleteFailed);
    } finally {
      void refresh();
    }
  }

  async function create(input: NewTask): Promise<boolean> {
    const target = targetOf(input.boardPublicId);
    const listPublicId = target?.listsByStage[input.stage];
    if (!target || !listPublicId) {
      setError(text.move.noList(target?.name ?? "", stageNames[input.stage]));
      return false;
    }
    const access = board?.access[target.project.publicId];

    setError(null);
    try {
      await createCard.mutateAsync({
        title: input.title,
        description: "",
        listPublicId,
        labelPublicIds: [],
        memberPublicIds:
          input.assignToMe && access ? [access.memberPublicId] : [],
        position: "end",
        dueDate: input.dueDate,
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      void refresh();
    }
  }

  return {
    move,
    setDue,
    archive,
    remove,
    create,
    isCreating: createCard.isPending,
    error,
    doneToast,
    dismissDoneToast,
    notice,
    dismissNotice,
    clearError: () => setError(null),
  };
}
