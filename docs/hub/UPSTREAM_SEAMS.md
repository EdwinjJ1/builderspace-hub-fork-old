# 上游接缝

我们改过的 Kan 文件全部列在这里。机器可读的版本是 [`packages/hub/seams.json`](../../packages/hub/seams.json)，两处要保持一致。

检查命令（需要先 `git fetch upstream main`）：

```bash
pnpm --filter @kan/hub check-seams
```

只改了已有依赖版本号的上游 `package.json`（Dependabot 的升级）不算接缝，会自动放行；新增或删除依赖、改脚本等其他改动仍然要登记。

它在三种情况下报错或提醒：清单之外的上游文件被改了；某个接缝文件里约定的标记不见了（比如同步上游时把我们那一行冲掉了）；被我们替换掉的上游组件在上游发生了变化。

## 接缝

| 文件                                                    | 改了什么                                                                                                                                                                        | 标记                 | 为什么                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/auth.ts`                             | `plugins` 末尾加上 `hubAuthPlugin(db)`，多一行 import                                                                                                                           | `hub-seam`           | 注册闸门                                                                                                                                                                                                            |
| `packages/auth/package.json`                            | 依赖里加 `@kan/hub`                                                                                                                                                             | `"@kan/hub"`         | 插件要调用 Hub 的准入规则                                                                                                                                                                                           |
| `apps/web/package.json`                                 | 依赖里加 `@kan/hub`、`remark-gfm`                                                                                                                                               | `"@kan/hub"`         | 页面和 API 路由要调用 Hub 的用例；文档页的 Markdown 要显示表格                                                                                                                                                      |
| `apps/web/src/pages/login/index.tsx`                    | 改为渲染 `hub/features/auth/LoginPage`                                                                                                                                          | `hub-seam`           | 我们自己的登录页；顺带校验 `?next=`，只接受站内路径                                                                                                                                                                 |
| `apps/web/src/pages/signup/index.tsx`                   | 改为渲染 `hub/features/auth/InviteOnlyPage`                                                                                                                                     | `hub-seam`           | 注册只能通过邀请链接                                                                                                                                                                                                |
| `apps/web/src/components/SideNavigation.tsx`            | 左上角的产品名改为 `copy.brand`；项目菜单换成 `HubSidebarTop`；导航链接先经 `useHubNavFilter` 过滤；导航下方加 `HubAdminLink`；改了几行 import                                  | `hub-seam`           | 去掉 Kan 的名字；切换项目改在首页做；没有权限的页面不出现在侧栏（模板只给项目管理员）；后台成员看到「后台」入口                                                                                                     |
| `packages/api/package.json`                             | 依赖里加 `@kan/hub`；`exports` 加 `./hub-mcp`                                                                                                                                   | `"@kan/hub"`         | 后台接口和权限检查住在 API 包里；网页的 MCP 端点要用这里的 MCP 工具                                                                                                                                                 |
| `packages/api/src/root.ts`                              | 挂上 `hub: hubRouter`，多一行 import                                                                                                                                            | `hub-seam`           | 后台的接口（`api.hub.*`）。放在 API 包内部，因为独立成包会和 `@kan/api` 循环依赖                                                                                                                                    |
| `packages/api/src/trpc.ts`                              | `publicProcedure` 和 `protectedProcedure` 末尾加一个中间件，调用 `guardPrivateBoards`；日志中间件的两条日志先经过 `anonymousLogEntry`；两行 import                              | `hub-seam`           | 看不到的私有看板（「仅自己可见」「仅管理员可见」）：任何接口只要入参里有它（或它的列表、卡片、标签、清单、评论、附件）的 ID，一律 `NOT_FOUND`。「催一下」的日志里不写调用者、入参和错误详情，否则日志会记下谁催了谁 |
| `packages/api/vitest.config.ts`                         | 加 `setupFiles`，指向 `routers/hub/vitest.setup.ts`                                                                                                                             | `hub-seam`           | Kan 自己的路由测试用假的数据库，加载不了也用不了上面的中间件；用真数据库的测试照常走中间件                                                                                                                          |
| `packages/api/src/routers/workspace.ts`                 | `create` 里调用 `assertCanCreateProject`；`search` 多传一个 `boardsVisibleTo(...)` 条件；两行 import                                                                            | `hub-seam`           | 只有后台管理员能新建项目；搜索不出看不到的私有看板和卡片                                                                                                                                                            |
| `packages/db/src/repository/workspace.repo.ts`          | `searchBoardsAndCards` 多一个可选参数 `boardFilter`，加进看板和卡片两条查询的条件里；多一行 import                                                                              | `hub-seam`           | 在 SQL 里就去掉看不到的私有看板，搜索的条数上限只算看得到的结果（事后过滤会让看不到的结果占掉名额）                                                                                                                 |
| `packages/api/src/routers/board.ts`                     | 创建看板时如果是模板，调用 `assertCanCreateTemplate`；`all` 的结果先经 `visibleBoardsOnly` 过滤；三行 import；`byId`、`bySlug` 多传 `hiddenCardIds: await archivedCardIds(...)` | `hub-seam`           | 只有项目管理员能建模板，普通成员仍可建普通看板；看板列表里没有看不到的私有看板；归档里的卡片不出现在看板上                                                                                                          |
| `packages/db/src/repository/board.repo.ts`              | `getByPublicId`、`getBySlug` 的 `filters` 多一个可选的 `hiddenCardIds`，加进卡片查询的条件里；多一行 import                                                                     | `hub-seam`           | Kan 的卡片没有归档，归档是 Hub 的表（`hub_archived_card`）；在 SQL 里去掉，看板页和公开看板页都看不到归档里的卡片                                                                                                   |
| `apps/web/src/components/Dashboard.tsx`                 | 没有任何项目时跳到首页，不再弹「创建工作区」，多一行 import                                                                                                                     | `hub-seam`           | 普通成员建不了项目；首页会告诉他等待管理员分配                                                                                                                                                                      |
| `apps/web/src/providers/workspace.tsx`                  | `switchWorkspace` 多一个可选的跳转目标，传 `null` 就留在当前页                                                                                                                  | `hub-seam`           | 首页切换项目时不被带去 `/boards`；从「全部」打开别的项目的卡片前先切过去                                                                                                                                            |
| `apps/web/src/styles/globals.css`                       | 加一条 `[hidden] { display: none !important; }`                                                                                                                                 | `hub-seam`           | 让 `hidden` 属性压过 `inline-flex` 之类的样式；下面几处靠它把没权限的按钮藏起来                                                                                                                                     |
| `apps/web/src/views/boards/index.tsx`                   | 权限改由 `useHubPermissions` 提供；「新建」「导入」按钮加 `hidden={!canCreateBoard}`                                                                                            | `hub-seam`           | 没权限就不显示；模板页上只有项目管理员能看到「新建」                                                                                                                                                                |
| `apps/web/src/views/boards/components/BoardsList.tsx`   | 网格最前面渲染 `OverallBoardTile`（总版）；空列表里的「新建」按钮同上处理                                                                                                       | `hub-seam`           | 每个项目的看板页先看到总版；没权限就不显示                                                                                                                                                                          |
| `apps/web/src/views/board/components/BoardDropdown.tsx` | 权限改由 `useHubPermissions({ creating: "template" })` 提供                                                                                                                     | `hub-seam`           | 看板菜单里的「Make template」只给项目管理员                                                                                                                                                                         |
| `apps/web/src/views/board/components/List.tsx`          | 「添加卡片」按钮加 `hidden={!canCreateCard}`                                                                                                                                    | `hub-seam`           | 没权限就不显示，而不是灰掉                                                                                                                                                                                          |
| `apps/web/src/views/board/index.tsx`                    | 两个「新建列」按钮加 `hidden={!canCreateList}`；`VisibilityButton` 的 import 换成 Hub 的 `BoardVisibilityButton`                                                                | `hub-seam`           | 没权限就不显示；「可见范围」菜单多「仅自己可见」「仅管理员可见」两项，见下面的替身                                                                                                                                  |
| `apps/web/next.config.js`                               | `rewrites` 末尾展开 `hubRewrites`（在 `src/hub/next-rewrites.js` 里），多一行 import                                                                                            | `hub-seam`           | MCP 客户端到站点根的 `/.well-known/oauth-authorization-server` 和 `/.well-known/oauth-protected-resource` 找登录信息；pages 路由只在 `/api` 下提供接口，所以转到 `/api/hub/oauth/*`                                 |
| `.github/workflows/test.yml`                            | `timeout-minutes` 从 15 改成 25                                                                                                                                                 | `hub-seam`           | Hub 的集成测试每个都起一个内存数据库，整套测试本来就要 13–14 分钟，15 分钟的上限已经没有余量（#55 要重跑才过，#56 被超时取消）                                                                                      |
| `pnpm-lock.yaml`                                        | 由 pnpm 重新生成                                                                                                                                                                | （生成文件，无标记） | 依赖变化                                                                                                                                                                                                            |

## 替身

这些上游组件我们不再渲染，由自己的组件接管。上游的文件原样留着不动；`seams.json` 记着我们上次对照时它的 git 哈希，上游改了会有提醒。

| 上游组件                                                   | 我们的替身                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/web/src/views/auth/login/index.tsx`                  | `apps/web/src/hub/features/auth/LoginPage.tsx`               |
| `apps/web/src/views/auth/signup/index.tsx`                 | `apps/web/src/hub/features/auth/InviteOnlyPage.tsx`          |
| `apps/web/src/components/WorkspaceMenu.tsx`                | `apps/web/src/hub/layout/HubSidebarTop.tsx`                  |
| `apps/web/src/views/board/components/VisibilityButton.tsx` | `apps/web/src/hub/features/boards/BoardVisibilityButton.tsx` |

## 新增一处接缝

先想能不能不改上游：新页面、新接口、新表都可以是新文件。确实要改时：

1. 改动控制在一两行，逻辑放进我们自己的文件，上游文件里只留调用。
2. 在改动处加注释 `hub-seam: <一句话原因>`（JSON 文件没法加注释，用依赖名之类必然存在的文本当标记）。
3. 在 `packages/hub/seams.json` 和上面的表里各登记一条。
4. 在 PR 描述里说明为什么非改不可。

## 同步上游

```bash
git fetch upstream main
git merge upstream/main
pnpm install
pnpm db:migrate                      # Kan 的迁移
pnpm --filter @kan/hub migrate       # Hub 的迁移
pnpm --filter @kan/hub check-seams
pnpm test
```

冲突只应该出现在上表列出的文件里。`check-seams` 如果提醒某个替身对应的上游组件变了，对照上游的改动决定替身要不要跟进，然后把 `seams.json` 里的 `upstreamSha` 更新为提示里的新值。
