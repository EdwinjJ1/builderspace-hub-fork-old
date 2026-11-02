# Hub 架构

BuilderSpace Hub 是 [Kan](https://github.com/kanbn/kan) 的一个 fork。看板、卡片、工作区、成员角色来自 Kan；准入注册、后台、首页这些是我们加的。这份文档讲我们的代码怎么放、为什么这么放。新增功能的步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)，改了哪些上游文件见 [UPSTREAM_SEAMS.md](UPSTREAM_SEAMS.md)，接下来做什么见 [ROADMAP.md](ROADMAP.md)。

## 一条规则

**我们的代码放在我们自己的目录里；上游文件只在登记过的「接缝」处改一两行。**

这样同步上游时冲突只可能出现在少数几个已知位置，新人也能一眼分清哪些是我们写的。`pnpm --filter @kan/hub check-seams` 会检查这条规则，CI 里每次都跑。

## 代码在哪

| 位置                                         | 放什么                                                                                              | 依赖                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------ |
| `packages/hub`                               | 领域逻辑和数据：表定义、迁移、规则、用例、运维命令行                                                | `@kan/db`、`@kan/shared` |
| `packages/auth/src/hub-plugin.ts`            | Better Auth 插件：注册闸门                                                                          | `@kan/hub`               |
| `packages/api/src/routers/hub/`（第 2 期起） | 薄接口层：校验入参 → 调用例 → 映射错误                                                              | `@kan/hub`               |
| `apps/web/src/hub/`                          | 我们的页面：`features/` 按功能分，`ui/` 通用小组件，`copy/` 文案，`lib/` 纯工具，`server/` 仅服务端 | `@kan/hub/public`        |
| `apps/web/src/pages/` 下的新文件             | 只有几行的页面入口，渲染 `hub/features` 里的视图                                                    |                          |

`packages/hub` 不能依赖 `@kan/auth` 或 `@kan/api`，否则会形成循环依赖。这也是接口层放在 `packages/api` 内部而不是独立成包的原因。

## `packages/hub` 内部的分层

每个功能一个文件夹（`access/`、`audit/`…），里面固定四种文件：

| 文件           | 职责                                               | 测试方式               |
| -------------- | -------------------------------------------------- | ---------------------- |
| `*.policy.ts`  | 纯规则，不碰数据库。例如「这条许可现在能不能用」   | 单元测试               |
| `*.repo.ts`    | 只写 SQL。第一个参数是 `db` 或事务 `tx`            | 通过用例的集成测试覆盖 |
| `*.service.ts` | 一个用例一个函数：校验入参、开一个事务、写操作日志 | 内存 Postgres 集成测试 |
| `index.ts`     | 这个功能对外暴露什么                               |                        |

另外两个特殊文件夹：

- `kan/*.gateway.ts`：**唯一**允许调用 Kan 的 repository 的地方。上游改了函数签名，只需要改这里。gateway 可以在上游没有合适函数时只读地查 Kan 的表，但从不直接写。
- `shared/`：邮箱规范化、令牌、错误类型。

`@kan/hub/public` 是唯一可以在浏览器里引用的入口，只有常量和纯函数。

## 数据库：独立的迁移流水

Hub 的表都以 `hub_` 开头，定义在 `packages/hub/src/schema/`，迁移文件在 `packages/hub/migrations/`，迁移记录写在 `drizzle.__hub_migrations`。Kan 的迁移照旧在 `packages/db/migrations/`，记录在 `drizzle.__drizzle_migrations`。

为什么不共用：Drizzle 只执行比「最后一次已执行迁移」时间更晚的条目。如果我们的迁移混在 Kan 的目录里，同步上游后，上游那些时间戳早于我们最新迁移的条目会被静默跳过。两条流水互不干扰就没有这个问题。

几条约定：

- 表的外键可以指向 Kan 的表（`user`、`workspace`…），但 `schema/` 里不要重新导出 Kan 的表，否则它们会进我们的迁移快照。
- 枚举用 `text` + `CHECK`，不用 `pgEnum`：Kan 已经占用了名为 `role` 的 Postgres 枚举。
- 生成迁移：`pnpm --filter @kan/hub generate --name <名字>`。执行：`pnpm --filter @kan/hub migrate`。
- 两个人同时生成迁移时，后合并的那个要重新生成，保证时间戳递增（有测试检查）。

## 注册闸门

没有注册许可的人注册不了。流程：

```
管理员发放许可（后台或命令行）
  → 生成一次性链接  https://<域名>/join#<令牌>   （库里只存令牌的 SHA-256）
  → 管理员私下发给本人
  → 本人打开链接，页面把令牌放在请求头 x-hub-grant 里
      → GET /api/hub/join-status    返回这条链接是否有效、对应哪个邮箱
      → POST /api/auth/sign-up/email 注册
          → hubAuthPlugin 的 user.create.before：令牌有效且邮箱一致才放行
          → user.create.after：provisionUser() 把账号加进预设项目，许可标记为已使用
```

几个容易踩的点，都是有意的设计：

- **令牌放在 `#` 后面和请求头里**，不出现在任何发给服务器的 URL 中，所以不会进访问日志。也**绝不作为 tRPC 入参**：Kan 的 tRPC 日志中间件会原样记录入参。
- **只登记邮箱是不够的**：Kan 的密码注册不验证邮箱归属，知道邮箱的人都能抢注。所以必须持有令牌。
- **插件钩子先于 Kan 自己的钩子执行**，任一返回 `false` 即拒绝，对所有注册方式都生效。
- **`provisionUser()` 是幂等的，after 钩子从不抛错**：Better Auth 在这一步没有事务，用户行已经提交，抛错会留下一个既不能完成也不能重试的账号。失败了只记日志，下次调用会补完。
- **不要设置 `NEXT_PUBLIC_DISABLE_SIGN_UP=true`**：它是 Kan 自己的开关，和我们的闸门是「与」的关系，打开后光有注册链接也会被拒。

### 录取后自动发链接

后台 → 官网 → 志愿者申请里，所有者或管理员把一份申请改成「已录取」时，`site/site.onboarding.ts` 接着做三件事：给申请里的邮箱发一条注册许可（来源记为 `application`，预设加入「BuilderSpace 社团」项目、成员角色），用 Resend 把带链接的欢迎邮件发出去，再写一条 `grant.mailed` 日志。卡片上的「发注册链接 / 重发注册链接」做同一件事，但会替换还有效的旧链接。

- **链接只活在邮件里。** 发信服务明确拒绝（4xx），许可当场撤销，不会留下一条谁都拿不到、却还能用的链接。没有得到明确结果（超时、断线、Resend 自己出错）时，先用同一个幂等键重试一次（第一次若其实已经发出，Resend 只回结果、不会再发）；仍然没有结果就**保留**链接，因为邮件可能已经到了对方手里，作废会让那封邮件里的链接失效。页面提示「可能已经发出」，没收到就点「重发」，日志记 `grant.mail_unconfirmed`。点「重发」时如果新邮件被明确拒绝，作废的是新链接，对方手里那条旧链接会恢复（`grant.restored`），不会因为一次失败的重发连旧链接也丢了。
- **录取先落地，再发信。** 发信失败不撤销录取，页面上给出原因，可以点按钮重试。
- **不会重复发。** 已经有账号的不发；还有没过期的链接时，改成「已录取」不发，要发新的就点「重发」。只有从别的状态改成「已录取」才会触发，重复保存不会。
- **谁能发。** 发许可本来就要 `access.manage`（所有者、管理员）。只有「名单」权限、没有后台角色的人改成「已录取」，录取照常生效，但不发链接，页面提示要管理员来发。
- **发信用 Hub 自己的变量。** `mail/` 只认 `HUB_RESEND_API_KEY`（以及可选的 `HUB_MAIL_FROM`、`HUB_MAIL_REPLY_TO`）。Kan 读的是 `SMTP_*` 和 `EMAIL_FROM`，设了会打开 Kan 自己的邀请和魔法链接邮件，绕过注册闸门，所以不用那几个名字。没设 key 时什么都不发，页面说明原因。
- **在 Supabase 表格里直接改状态不会触发**，因为那不经过 Hub。这类录取，以及只有「名单」的人改的、配好发信之前录取的，用命令行 `mail-links` 补发（`site.service.ts` 的 `mailAcceptedApplicants`）：它扫一遍「已录取」，只给从没发过链接、也没注册的地址发，同一个地址只发一封，两封之间隔 0.6 秒（Resend 每秒最多两封），所以可以反复跑。链接过期的人只列出来不重发，重发要 `--email` 点名，这时和卡片上的「重发」一样会替换旧链接。命令行以所有者身份发许可，日志的操作人记为 `cli`。

### 邮箱

后台 → 官网 → 邮箱（`/admin/site/inbox`）读 Resend 收到的信，代码在 `packages/hub/src/inbox/`。

- **不存信。** 列表和正文每次都从 Resend 的 `/emails/receiving` 现取（`inbox.resend.ts`），Hub 没有表、没有 webhook。Resend 删了的（免费版 30 天）这里也就没了。翻页用 Resend 的游标（`after` = 上一页最后一封的 id），所以只有「较新 / 较旧」，没有页码。
- **权限是 `hub_account.mailAccess`**，和 `siteAccess` 一样由所有者逐人设置，和后台角色、官网权限都无关。`hubInboxProcedure` 先查它和 key，用例里再查一次；附件路由不走 tRPC，自己查一遍。
- **单独的 key。** 读收件要 Full access，发信用的 `HUB_RESEND_API_KEY` 应该只有 Sending access，所以邮箱用 `HUB_RESEND_INBOX_API_KEY`。
- **HTML 的隔离**都在 `inbox.policy.ts`（浏览器和测试共用）：`MAIL_FRAME_SANDBOX` 不含 `allow-scripts` 和 `allow-same-origin`；`mailFrameDocument` 把我们的 CSP 放在信的前面（信里自带的 CSP 只能更严），去掉 `meta refresh`，远程图片要点了才放开。
- **附件**的下载链接会过期，页面链到 `/api/hub/inbox/<信>/attachments/<附件>`，点的时候才向 Resend 要新链接，再 302 过去。带 content id 的内嵌图片已经显示在正文里，不列为附件。

## 首页与大看板

`packages/hub/src/tasks/` 负责首页（`/home`）和跨项目大看板（`/tasks/<视图>`）。两者都有一个「范围」：「全部」或某一个项目，写在 URL 的 `?project=` 里。

- **谁能看到哪个项目**只有一个出口：`kan/tasks.gateway.ts` 的 `listViewableProjects()`。条件是正式成员（不是待接受的邀请、没被移除），并且按 Kan 自己的规则算出的有效权限（角色加个人覆盖）同时包含 `board:view` 和 `card:view`。「全部」就是这些项目的合集，别的项目在切换条、计数、看板里都不出现。问一个自己不在的项目，和问一个不存在的项目，得到的回答一样（`NOT_FOUND`）。
- **阶段和职能按名字识别**（`task.policy.ts`）：列名对上「待办 / 进行中 / 待验收 / 已完成」（以及 Kan 模板的英文列名）就进对应的列，对不上的进「其他」；看板名对上「开发 / 运营 / 营销」就算对应职能。标准名字只在 `@kan/builderspace/structure` 里写一次。
- **切换项目在首页做**。侧栏顶部的 `HubSidebarTop` 替换了 Kan 的 `WorkspaceMenu`，只显示当前项目（点击回首页），保留搜索和 ⌘K。Kan 把「当前项目」存在浏览器里，看板页和卡片页都读它，所以首页选中某个项目时会同步过去（`useFollowScope`），从「全部」打开别的项目的卡片前也会先切换（`useOpenInProject`）。
- **首页即总版**：首页的分类卡片和「我负责的任务」下面，直接嵌入当前范围的总版（`TaskBoardBody`，和 `/tasks/all` 是同一个组件、同一份数据），可以就地编辑。
- **总版**：某个项目的「全部」视图就是这个项目的总版，Kan 的看板页上第一块就是它的入口（`OverallBoardTile`）。总版里的卡片按职能着色；有编辑权限的人可以把任务拖到另一列、改截止日期、新建任务（选放到哪个职能、哪一列，可勾「指派给我」）。这些操作都直接调用 Kan 自己的 `card.update` / `card.create`：卡片本来就是小看板上的那一张，所以小看板、首页「我负责的任务」立即同步，Kan 也照常校验权限、写卡片活动记录。拖动时按目标看板里对应阶段的列来移，没有那一列就提示，不会移到别的看板。
- **只看我的**：大看板和首页的总版上有「只看我的」开关，打开后只留下指派给我的任务（`tasks.board` 的 `onlyMine`，规则在 `task.policy.ts` 的 `onBoard`）。先筛选再计数、再截「已完成」列，所以列头的数字和「已完成」的条数都是我自己的。大看板把它写在 URL 的 `?assigned=me` 里，切换项目时带着；首页的放在页面状态里，切换范围也保留。「指派给我的」视图本来就只有自己的任务，不显示这个开关。
- **职能颜色**存在 `hub_setting` 表（`settings/`），后台「职能颜色」页修改，所有登录的人都能读；读到的值不合法时按职能退回默认色。

## 项目权限与「没权限就不显示」

- **数据只有一份**：成员和访客能做什么，存在 Kan 自己的角色权限表里。后台「项目权限」页（`packages/hub/src/permissions/`）读写的就是这张表，所以 Kan 的页面、接口和我们的首页都立即跟着变。项目管理员的权限固定为全部；删除项目和管理计费只给管理员，和 Kan 一致。
- **Kan 不知道的规则**由 Hub 固定：新建项目只有后台管理员（`guards.ts` 的 `assertCanCreateProject`），新建模板只有项目管理员（`assertCanCreateTemplate`）。
- **界面上没权限就不显示**：Kan 的视图通过 `useHubPermissions()`（Kan 的 `usePermissions` 加上 Hub 的规则）拿权限；原来没权限时灰掉的按钮加了 `hidden`，全局样式保证 `hidden` 一定生效；侧栏链接先经 `useHubNavFilter()` 过滤。服务端照样各自校验，界面只是不再展示做不了的事。

## 仅自己可见、仅管理员可见的看板

Kan 的看板只有两种可见性：`public`（不登录拿到链接也能看）和 `private`（项目成员都能看）。`packages/hub/src/private-boards/` 另加了两种，统称「私有看板」：

- **仅自己可见**：只有看板的主人能看到这个看板、它的列表和卡片，项目管理员也看不到。
- **仅管理员可见**：只有这个项目的管理员能看到。管理员按 Kan 成员表的 `role = 'admin'`（有效、未删除）现查，不存名单，所以换了管理员，看得到的人立即跟着变。别的项目的管理员看不到。

- **一张表**：`hub_private_board`，有一行就是私有看板，`audience` 是 `owner`（仅自己可见）或 `admins`（仅管理员可见）。仅自己可见时 `ownerUserId` 是主人；主人删号后这一列变成空，看板从此谁都看不到，而不是退回给整个项目看：设成仅自己可见的人不想让别人读到。仅管理员可见时 `ownerUserId` 只记谁设的，这个人删号不影响谁能看。
- **谁能设**（`private-board.policy.ts` 的 `canSwitchAudience`）：要改到哪一档，得既能离开现在这档、又能进入那一档。离开仅自己可见：主人；离开仅管理员可见：项目管理员。进入仅自己可见：看板的创建者（别人不能把你建的看板藏起来不让你看）；进入仅管理员可见：项目管理员，任何看板都可以，包括普通成员建的（之后创建者也看不到）。两种私有之间可以直接切换，不经过「社团成员可见」，中间不会有一刻让成员看到。设成私有时同时把 Kan 的可见性改成 `private`，公开链接立即失效；改回「社团成员可见」后要公开得再单独改一次。私有看板不能直接改成公开（接口回 `CONFLICT`）。规则检查读的是事务开始前的状态，所以写入时带条件（`switchPrivateBoard`：只在看板仍是检查时那一档时才改）；两个人同时改，只有先写的成功，后一个回 `CONFLICT`，不会把别人刚设的覆盖掉。
- **一个入口挡住 Kan 的所有接口**：`packages/api/src/trpc.ts` 里给 `publicProcedure` 和 `protectedProcedure` 都加了一个中间件（接缝）。它读请求的入参，凡是字段名以 `boardPublicId`、`listPublicId`、`cardPublicId`、`labelPublicId`、`checklistPublicId`、`checklistItemPublicId`、`commentPublicId`、`attachmentPublicId`（以及复数形式）结尾的，都查一下属于哪个看板；有一个属于调用者看不到的私有看板，整个请求回 `NOT_FOUND`，和看板不存在一样。按字段名结尾匹配，所以 `sourceBoardPublicId` 这类带前缀的字段，以及上游以后新加的同类字段，不用登记也会被检查。入参里没有这些字段的请求不查库。浏览器、REST（`/api/v1`）、MCP 都经过 tRPC，所以都被挡住；`hub.*` 也一样。
- **中间件读的是还没校验的入参**（在接口自己的 zod 之前），所以先设了上限：超过 12 个字符的 ID 不查（这些表的 `publicId` 都是 `varchar(12)`，不可能对得上），同一个 ID 只算一次，一个请求最多 200 个，超过就直接回 `BAD_REQUEST`，一条 SQL 都不跑。不设上限的话，不登录的人也能发一个塞了几万个 ID 的请求，让数据库去查。
- **Kan 自己拼的列表另外过滤**：`board.all`（项目的看板列表）的结果经 `onlyVisibleBoards` 去掉看不到的私有看板。`workspace.search`（⌘K 搜索）有条数上限，事后过滤会让看不到的结果占掉名额，所以把 `boardVisibleTo(viewerId)` 作为条件传进 Kan 的搜索 SQL（`workspace.repo.ts` 的接缝）。首页、总版、我完成的、个人日程都从 `kan/tasks.gateway.ts` 的 `listTaskRows` / `listBoardsWithLists` 取数据，那里的 SQL 也带上了同一个条件。
- **`boardVisibleTo` 是 `canSeePrivateBoard` 的 SQL 版**：两处规则要一起改。仅管理员可见那一支是对 Kan 成员表的相关子查询（按外层 `board.workspaceId`），所以只能用在 `FROM` 里有未取别名的 `board` 表的查询上。中间件和 `onlyVisibleBoards` 只在碰到仅管理员可见的看板时才多查一次「我是哪些项目的管理员」。
- **界面**：看板页的「可见范围」按钮换成了 `BoardVisibilityButton`（替身），四个选项：公开链接、社团成员可见、仅自己可见、仅管理员可见。后两项能不能选由服务端 `hub.boards.privacy` 的 `canSwitchTo` 决定，改用 `hub.boards.setAudience`。
- **操作日志不写看板名**：日志只记「把自己建的一个看板设为仅自己可见」「把一个看板设为仅管理员可见」这类话和看板的 ID。后台管理员能读日志，看板名本身就是想藏的内容。
- **已知的局限**：项目如果配置了 webhook（Kan 的 `sendWebhooksForWorkspace`），仍会收到私有看板里卡片的创建、修改、删除事件；上传附件的 `/api/upload/attachment` 不经过 tRPC，只看项目权限，能往别人的私有卡片上传附件（读不到），前提是知道卡片的 ID，而且线上没配文件存储时这个接口本来就用不了。

## 限流

登录、注册和注册链接检查都有按 IP 的限流，计数存在 `hub_rate_limit` 表里（`packages/hub/src/rate-limit/`）。放在数据库而不是内存，是因为线上跑在多个无服务器实例上，各自在内存里计数等于没有限制。

- Better Auth 自带限流逻辑，`hubAuthPlugin` 给它换上数据库存储（`rateLimitStorage`），并对邮箱密码登录、注册、申请重置密码加了更严的规则（`HUB_AUTH_RATE_LIMITS`）。插件的选项只填补 Kan 没设置的项，所以 `DISABLE_RATE_LIMIT` 仍然有效（测试里就用它关掉）。
- Better Auth 的计数是「先读再写」两步，并发请求会读到同一个旧值、一起放行。所以这三类路径在插件的 `onRequest` 里另用 `consumeRateLimit` 原子计数一次（key 以 `hub-auth:` 开头），并发打进来也只放行规定的次数；Better Auth 自己那层照常保留。
- 两层在数据库出错时都放行（不因为数据库抖动把人挡在门外），但都会记错误日志（`Sign-in rate limit check failed`、`Rate limit storage failed`）。
- Hub 自己的 API 路由用 `withHubRateLimit`（`apps/web/src/hub/server/rate-limit.ts`），背后是一条原子的 `INSERT … ON CONFLICT` 语句，并发请求也不会多放行；`DISABLE_RATE_LIMIT=true` 时同样关闭。
- 计数按 `X-Forwarded-For` 的第一个地址算，自己部署时代理必须改写这个头，见根目录的 [SECURITY.md](../../SECURITY.md)。

## 个人日程

`packages/hub/src/schedule/` 负责 `/me`（个人）：一个人自己的一周，有空、没空、会议，以及排给任务的时间。

- **一张表**：`hub_time_block`，每行是一段属于某个人的时间（起止、类型、标题）。`task` 类型的块只存关联的卡片，**标题和状态每次都从卡片读**，所以看板里改名、完成，日程立刻跟着变，不会各存一份、慢慢对不上。
- **任务从哪来**：`tasks/task.service.ts` 的 `getMyTasks()`，也就是首页「指派给我的」同一套规则（我能看的项目里、指派给我的卡片）。被取消指派、离开项目、卡片被删，对应的块从日程里隐藏但不删除，重新指派后会回来。
- **只有本人能看**：每个用例都以 `userId` 为界，查别人的块得到的回答和查不存在的一样（`NOT_FOUND`）。
- **不写操作日志**：这是对「每个改数据的用例都要有操作日志」的有意例外。操作日志后台管理员能看，而一个人的日程不该被管理员读到；日志里哪怕只记「改了一个标题」也会泄露内容。测试里有一条断言保证这点。
- **时间**：库里存绝对时刻（UTC），哪一天、几点由浏览器的时钟决定。页面的格子换算在 `apps/web/src/hub/lib/schedule-layout.ts`，是不依赖 React 的纯函数，测试在三个时区下都跑过。
- **交互**：先选一种「画笔」（没空 / 有空 / 会议，或者点右边的一个任务），再在时间表上拖。点一下是一小时；拖块移动，拖块的下沿缩放。

## 文档库

`packages/hub/src/documents/` 负责 `/documents`：用 Markdown 或 HTML 在页面里写和编辑的文档。**不存附件，不用对象存储。**

- **内容在数据库里。** 表：`hub_document`（标题、文件名、大小、`storageKey`、可读开关）、`hub_document_reader`（指定的人，见下）、`hub_document_blob`（内容本身，按 `storageKey` 存，最大 400 KB）、`hub_document_folder`（文件夹，可嵌套，最多 3 层）、`hub_document_editor`（谁被指派可以改哪份文档）、`hub_document_edit_request`（申请记录）。`DocumentStorage` 接口只剩一个实现 `storage.db.ts`；接口保留是为了让内容存放的位置和业务规则分开，测试里另有一个内存实现。
- **历史：** 文档库最早做过文件上传（浏览器直传 S3 兼容存储，PDF、PPT 等），后来决定不需要附件，整条路删掉了：上传分两步的用例、S3 和磁盘存储、上传路由、导入命令。迁移历史不改写：`hub_document_upload` 表留着（表里没有数据，代码不再读写它），要彻底去掉得另写一条迁移。`hub_document.storageKey` 仍在用：它是内容在 `hub_document_blob` 里的键。线上从没配过 bucket，所以没有需要搬走的文件。
- **权限规则全在 `document.policy.ts`**，界面和接口都不另写。读：三档，「所有成员」「指定的人」「只有能修改的人」；能修改的人始终能读。新建：所有者、管理员（`documents.manage`）。修改：所有者，或被指派的人；管理员不是所有文档的编辑者。指派和处理申请：所有者，和自己是编辑者的管理员；被指派的普通成员不能再往下指派。读不到的文档和不存在的文档，回答一样（`NOT_FOUND`）。
- **谁能看（`audience.service.ts`）**：存的是可读开关加 `hub_document_reader` 里的名单。开关开着 = 所有成员；关着、名单里有人 = 指定的人；关着、名单是空的 = 只有能修改的人。名单的每一行是一个人、一整个项目，或一个项目里的一个部门（见下面「部门」）。判断按读的那一刻算：项目看此刻是不是这个项目的在职成员，部门看此刻是不是在这个项目的这个部门里，所以离开项目、被移出部门后立刻读不到。只在开关关着时保留名单，打开时清空，不会出现「开着但有名单」。名单里的人或项目都没了（账号、项目被删）时，文档退回只有能修改的人能看，不会变成所有人可读。挑人的选项（`hub.documents.audienceOptions`，列出每个项目的成员和部门）只给能新建文档或能修改某份文档的人，普通成员拿不到项目名单。命令行用的 REST 接口照旧收发 `readable` 开关：`true` 设为所有成员，`false` 设为只有能修改的人，和现状一样时不动（所以命令行不会把「指定的人」冲掉）；返回里另有 `audience`。
- **上传 = 在浏览器里把文件变成文本。** `file-import.ts` 读 `.md` / `.markdown` / `.html` / `.htm`（必须是 UTF-8），把 Word（`.docx`）用 mammoth 转 HTML、再用 turndown 转 Markdown：表格的第一行当表头，图片去掉并计数。结果填进「新建文档」对话框，人看过再保存，走的还是 `createText`，服务端没有上传接口。转换放在浏览器，是因为带图的 `.docx` 很容易超过 tRPC 1 MB 的请求上限；转换库只在选了文件时才加载（`import()`），`IMPORT_ACCEPT` 在 `@kan/hub/public` 里，页面不用为了它加载转换库。
- **格式白名单，类型由我们定。** 只认扩展名 `.md`、`.html`、`.htm`（`inspectFile`），不信客户端报的类型。读的时候返回的类型也由我们定：Markdown 经文件接口一律按纯文本输出，从不解释。
- **渲染：** Markdown 在页面里用 react-markdown 加 remark-gfm 渲染（支持 GitHub 的表格、任务列表、删除线；不解释原始 HTML，去掉危险的链接地址），不需要沙箱。HTML 是唯一能带代码的格式，只在沙箱里显示：`<iframe sandbox="allow-scripts …">` 没有 `allow-same-origin`，页面被当作来自「无处」，能跑脚本，但读不到本站的 cookie、存储和接口；文件接口的响应头再加一道 `Content-Security-Policy: sandbox`，直接打开链接也一样。
- **读内容有两个出口：** 页面里的 `hub.documents.content`（tRPC，给编辑器和 Markdown 渲染），和 `GET /api/hub/documents/<id>/file`（给 HTML 的 iframe 和「下载」）。两者都先检查登录状态和权限，不缓存（读的权利可以被收回），文件接口不接受 API key。
- **写内容** 都走 `text.service.ts`：页面里的「新建文档」「编辑内容」和命令行的 `bshub doc`。保存时带上打开时的 `updatedAt`，别人在此之后改过就拒绝，不会悄悄覆盖。上限 400 KB（页面里写的内容要经过 Kan 的 tRPC 路由，请求体上限 1 MB，转义后会变大）。
- **给命令行的 REST 接口** `GET/POST /api/hub/v1/documents…`（`documents/rest.ts` 只管路由和参数，不含任何权限规则；`pages/api/hub/v1/documents/[[...path]].ts` 管 HTTP）。新建和修改文档时可以传 `audience`（所有成员 / 指定的人 / 仅编辑者，和网页的「谁能看」同一套规则），`GET …/documents/audience-options` 列出能指定的人、项目和部门。看板的可见范围走 `GET/PUT /api/hub/v1/boards/{publicId}/audience`（`private-boards/rest.ts`，调用和看板页同一个 `setBoardAudience`），认证和文档接口一样。**只认 API key**，不认浏览器会话：cookie 会随别的网页发出的请求一起带上，而这套接口不需要它；查 key 之前先去掉 cookie 头。**刻意不提供**删除文档和删除文件夹、指派/收回/处理修改权限：API key 现在没有权限范围，泄露后不应该能删文档或转让编辑权，这些只在网页里做。读不到的文档回 404，和不存在一样。
- **每个改数据的用例都有操作日志。**
- **已知的局限**：没有版本历史（保存会覆盖旧内容）；只有 Markdown 和 HTML，没有附件；还没加入项目的成员被 Kan 的外壳重定向到首页，看不到文档。

## 部门

`packages/hub/src/departments/` 管社团的部门：一套名单所有项目共用（起步是技术、活动、运营，迁移里写好），每个项目里谁在哪个部门各自设置。后台「部门」页（`/admin/departments`）新建、改名、上下移动部门，按项目勾选成员所在的部门；账号详情页也能改这个人的部门。

- **两张表**：`hub_department`（名字、顺序）和 `hub_department_member`（部门、项目、人）。部门**不能删**（2026-10-24 定）：外键都是 `restrict`，文档「指定的人」里引用的部门一直在。
- **部门不是职能**：职能（看板）还是 `@kan/builderspace/structure` 里那三块，新建部门不会新建看板，改部门名也不会改看板名。起步的三个部门和职能同名，只是因为社团就是这么分的。
- **谁能改**：能管理账号的人（`accounts.manage`，所有者和管理员）；后台只读成员能看不能改。只能把已经在项目里的人放进这个项目的部门；有人离开项目后记录不删，但不再算数，回到项目后恢复。
- **每次改动都写操作日志**（新建、改名、移动、加人、移出）。

## 表单

`packages/hub/src/forms/` 负责 `/forms`：可复用的表单，收集回答，后台看数据。

- **表**：`hub_form`（标题、状态、谁能填、截止时间、名额；题目 `definition` 和设置 `settings` 是 JSON）、`hub_form_manager`（除所有者外谁能管理这份表单）、`hub_form_response`（一份回答，`answers` 是 JSON）、`hub_form_image`（图片，字节存库里）、`hub_form_like`（结果墙上的赞）。题目和设置整体读写，所以放 JSON 而不是一题一行；每次写入都经 `form.model.ts` 的 zod 校验，保存时带上打开时的 `updatedAt`，别人改过就拒绝。状态不在保存的内容里，所以在页面上开始/停止收集、改回草稿时也带上这个时间：改之前它还是最新的，服务端就回新的时间让页面接着用，没保存的改动照样能保存，不会被当成「被别人改过」。
- **规则分三处**：`form.model.ts` 是纯函数（题型、上限、题目检查 `checkDefinition`、答案检查 `checkAnswers`、表单此刻收不收 `formPhase`），从 `@kan/hub/public` 导出，**浏览器里的编辑器和填写页跑的是同一套检查**；`form.policy.ts` 是谁能做什么；`image.policy.ts` 按字节认图片。
- **谁能做什么**：新建是所有者和管理员（`forms.manage`）；改题目、看回答、导出是所有者和这份表单的管理者（创建者自动是）；把表单交给别人、删除表单是所有者和管理它的管理员。管理员不能看别人表单的回答（里面可能有电话）。看不到的表单和不存在的一样回 `NOT_FOUND`。
- **只给管理者看**（`settings.managersOnly`）：打开后，所有者也不再自动能管理这份表单，只有名单上的人能看到它、它的回答、统计、导出和答案图片（`isHiddenForm` + `canManageForm`，列表的 SQL 同样过滤）。为了不让表单变成谁都看不到：不在名单上的人不能打开这个开关；名单只剩一人时不能再移除；名单上的账号都被删掉后，自动回到所有者可见。填写和结果墙照常按各自的设置走，操作日志里仍记表单标题。早于这个开关存的表单没有这个字段，一律按关闭处理。
- **谁能填**：`public`（拿到链接就能填，不用登录）、`members`（登录的成员）、`projects`（指定项目的成员）。不能填的人只看到标题和原因，题目不下发。停用的账号按没登录算。
- **填写走普通 API 路由，不走 tRPC**：`/api/hub/forms/…`（`forms/rest.ts` 管路由，`pages/api/hub/forms/[[...path]].ts` 管 HTTP）。一是公开表单不登录也要能用，而 tRPC 回 UNAUTHORIZED 会把浏览器踢去登录页；二是回答里有电话、邮箱，Kan 的 tRPC 日志会原样记录入参。写请求必须是 `application/json` 或 `image/*`，别的网站发不出来，所以不能冒用别人的登录提交。每类请求各有按 IP 的限流。管理者用的增删改查走 `hub.forms.*`（tRPC），入参只有题目和设置。
- **一份回答**：签名用户的回答记 `userId`；不登录的回答在提交时发一个编辑令牌（只回给这一次，库里存 SHA-256），浏览器存在 localStorage，凭它找回、修改自己的回答，也凭它看到自己传的图。每次提交带一个浏览器生成的 `submissionKey`，网络断了重发不会多出一份（唯一索引兜底）。
- **并发**：提交时先 `SELECT … FOR UPDATE` 锁住表单这一行，再数名额、查「每人一次」，所以两个人同时抢最后一个名额只会成功一个。
- **改题目**：有回答之后题目类型不能改（文字答案不能变成选项）；删题、删选项可以。每个答案存了题目标题和所选选项的文字，删掉的题在回答列表、导出和统计里显示为「已删除的题目」。
- **图片**：存在数据库里（`bytea`），跟文档一样不需要 bucket。浏览器先缩到最长边 1600 像素、转 WebP（不支持就 JPEG），顺带去掉照片里的 EXIF（可能有拍摄地点）；只有小 GIF 原样上传（保留动画）。服务端只认按字节判断出的 JPEG、PNG、WebP、GIF（SVG 能带脚本，不收），单张最大 3 MB，一份表单的图片合计 200 MB。答题的图先上传、再在提交时认领；一天内没被认领的自动清掉，没被题目引用的表单图片一天后也清掉。读图片要过权限：表单自己的图跟着「谁能填」走；答案里的图只给管理者、提交的人和结果墙的观众（那道题勾了「在结果墙展示」时）。公开表单的图可以缓存，其余一律不缓存。响应头带 `nosniff` 和 `sandbox` 的 CSP。
- **结果墙和点赞**：结果墙只展示勾了「在结果墙展示」的题（电话、邮箱这类建议关掉），名字只在开了「显示名字」且是登录填写时出现，邮箱永远不出现。点赞每人（`u:<用户>`）或每个浏览器（`b:<随机键的哈希>`）一次，不能给自己点。不登录的点赞只是尽力而为：换浏览器就能再点。
- **操作日志**：新建、修改、开始/停止收集、复制、删除、指派管理者、删除回答都记。**提交回答不记**：量大、是内容不是管理，而且日志对不管这份表单的后台成员也可见。
- **已知的局限**：不登录的「每人一次」只能按浏览器限制；没有题目跳转逻辑；回答超过 5000 份时统计和导出只算最新的 5000 份；图片在数据库里，Neon 免费档总共 0.5 GB，大量收图之前要先看容量。

## 催一下

`packages/hub/src/nudges/` 负责首页右上角的铃铛：看到队友的任务好几天没动，点一下就给 TA 发一封匿名邮件，列出 TA 还没做完的事。

- **谁会出现在名单里**（`nudge.policy.ts`）：在我能看到的任务里（`listTaskRows`，所以别人仅自己可见看板上的任务不算），指派给某人、没做完、并且已逾期或者 3 天没人动过（`STALE_AFTER_DAYS`）。「动过」取卡片的创建时间、`updatedAt` 和最近一条卡片活动里最晚的那个（`lastActivityByCard`）：Kan 把卡片移到另一列时不改 `updatedAt`，但会记活动，评论也会。名单不含自己，不含被停用的账号；逾期的排前面，其次是放得最久的。
- **邮件写什么**（`nudge-email.ts`）：收件人自己所有没做完的任务，按截止日期排序，最多 8 件，其余写「还有 N 件」。按收件人自己的权限取，所以会列出点按钮的人看不到的任务：邮件只有收件人自己读。每行注明已逾期、今天到期、几月几日到期或者几天没动，日期按悉尼时间。纯文本，和录取邮件一样走 Hub 自己的 Resend（`HUB_RESEND_API_KEY`），没设 key 时名单照常显示，但不能发。
- **一小时一封**：按收件人计数（`hub_rate_limit`，key 是 `hub:nudge:<收件人>`），不管多少人点。发信服务明确拒绝时把这一小时还回去，下一个人可以马上再点；没有得到明确结果时保留，因为邮件可能已经到了。「全部催一遍」由页面逐个调用，两封之间隔 0.6 秒（Resend 每秒最多两封）。
- **匿名靠的是不存，而不只是不显示**：哪里都不记是谁点的。计数只按收件人；Kan 的日志中间件本来会把每次调用的用户 ID 和入参（收件人）写进服务器日志（配了 Axiom 也会进 Axiom），`hub.nudges.send` 的日志经 `routers/hub/anonymous.ts` 去掉调用者、入参和错误详情（数据库错误可能带查询参数），只留接口名、状态码、错误码和耗时（`trpc.ts` 的接缝）。托管平台自己的访问日志照常记请求路径和 IP，和其他请求一样，但请求体里的收件人不会进去。发提醒也**不写操作日志**，这是「每个改数据的用例都要有操作日志」的又一个有意例外（同个人日程）：日志对后台管理员可见。代价是有人乱点也查不到是谁，但每人每小时最多一封，收件人也可以关掉。
- **默认订阅，可以退订**（2026-10-24 定）：`hub_nudge_opt_out` 只存关掉的人，没有记录就算开着。在「个人 → 提醒」（`/me/reminders`）里开关，邮件最后一行链到这里。开关写操作日志（只记「打开 / 关掉了催一下邮件」）。关掉的人还在名单上，标「关了提醒」，不能点。
- **做完一件后的提示**：在总版（首页和 `/tasks`）把任务拖到「已完成」后，右下角弹出「做完一件，还剩 N 件」和接下来三件，8 秒后自己消失，不发邮件。数据是首页「指派给我的」那一份（`hub.tasks.home`，范围「全部」）。Kan 自己的小看板里拖动不会弹：那要改上游的看板页。

## MCP

`packages/hub/src/mcp/` 和 `packages/api/src/routers/hub/mcp/` 负责让 AI 应用（Claude Code、Cursor、Codex、Claude 桌面版等）通过 MCP 使用 Hub。左侧「MCP」页（`/mcp`）是给人和 AI 看的接入说明，顶上「复制本页 Markdown」把整页交给 AI；页面内容是 `apps/web/src/hub/lib/mcp-guide.ts` 生成的数据，渲染和复制用的是同一份，不会对不上。同一页还列出能以本人身份使用 Hub 的应用和令牌，可以生成令牌、断开、撤销。

```
AI 应用 POST /api/hub/mcp（没有令牌）
  → 401，WWW-Authenticate 指向 /.well-known/oauth-protected-resource/api/hub/mcp
  → 读 /.well-known/oauth-authorization-server，POST /api/hub/oauth/register 自报家门
  → 打开浏览器到 /mcp/authorize（没登录先去 /login，登录后回来）
      → 页面显示应用自报的名字、登录的邮箱、回跳地址，人点「允许」
      → 回跳地址带上一次性授权码（5 分钟，只能用一次）
  → POST /api/hub/oauth/token：授权码 + PKCE 换访问令牌（1 小时）和刷新令牌（30 天，用一次换一对新的）
  → 之后每次调用 /api/hub/mcp 都带 Authorization: Bearer
```

不支持 OAuth 的客户端：本人在 MCP 页「生成令牌」（`bsh_pat_…`，7 / 30 / 90 天，只显示一次），自己填进客户端配置的 `Authorization: Bearer` 请求头。

- **权限就是网页的权限。** 每个工具都用 `appRouter.createCaller` 以本人身份调用网页用的那些过程（`hub.*`、Kan 的 `card.*`），所以权限检查、「仅自己可见」看板的拦截、文档的可见范围、操作日志全和网页一样，MCP 这边不另写规则。工具列表按人过滤（`catalog.ts` 的 `toolsFor`），只是为了让 AI 少试错；真正的拦截仍在每个过程里，测试里普通成员直接点名调用后台工具也会被拒。

  | 账号                                    | 能用的工具                                                                                                                                                                                                                          |
  | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 所有成员                                | `whoami`、`home_summary`、`task_board`、`task_get`、`task_create`、`task_move`、`task_update`、`task_comment`、`doc_list`、`doc_read`、`doc_update`（在哪个项目能建、能改任务，哪份文档能看、能改，照旧按项目权限和每份文档的设置） |
  | 后台「只读」（`admin.view`）            | 再加 `admin_overview`、`project_list`、`account_list`、`account_get`、`department_list`、`grant_list`                                                                                                                               |
  | 管理员、所有者                          | 再加 `account_set_project_role`、`department_set_member`（`accounts.manage`）、`grant_revoke`（`access.manage`）、`audit_list`（`audit.view`）、`doc_create`、`doc_audience_options`（`documents.manage`）                          |
  | 官网「名单」或「管理」（`site.people`） | 再加 `volunteer_list`、`volunteer_update`（改成「已录取」和网页上一样自动发注册链接邮件）                                                                                                                                           |

  所有者只比管理员多 `admins.manage`（任命角色、官网权限），这些不在 MCP 里，所以两者在 MCP 里一样。

- **刻意不给的**（`mcpNotOffered`）：删除任何东西、改已有文档的可见范围和编辑权限、任命或撤销后台角色和官网权限、发带后台角色的注册链接、新建账号和重置密码（临时密码会出现在 AI 的对话里）、停用账号、新建或改名部门、改项目权限表和全站设置。这些只在网页里做。AI 新建文档时默认只有所有者和编辑者看得到（`audience: editors`），要给所有人或指定的人看得明说。要加工具，先在 `catalog.ts` 登记，再在 `tools.ts` 实现，有测试保证两边一致。
- **为什么 `hubProcedure` 放行 MCP。** 它拒绝 API key，因为 key 没有范围、不会过期、泄露了就是全部权限。MCP 的令牌不同：OAuth 的是本人在授权页点过「允许」的，1 小时过期；生成的令牌最长 90 天，只在 `/api/hub/mcp` 上有效（tRPC 和文档 REST 都不认它）。两种都能在 MCP 页一键断开或撤销，账号被停用就立即失效。MCP 调用时请求头里没有 cookie 也没有 API key，所以 `hubProcedure` 把它当网页请求处理。
- **令牌的一生。** 授权码、访问令牌、刷新令牌、生成的令牌都只存 SHA-256，带前缀（`bsh_code_`、`bsh_at_`、`bsh_rt_`、`bsh_pat_`）方便密钥扫描认出来。刷新时两个令牌一起换，旧刷新令牌立即作废，两个请求同时用同一个刷新令牌只有一个成功。同一个应用重新登录会替换它之前的连接，不会在 MCP 页上越积越多；过期的连接不再列出，新建连接或令牌时顺手删掉。每人最多同时 10 个有效的生成令牌。撤销有三条路：MCP 页「断开」「撤销」、应用调用 `/api/hub/oauth/revoke`（RFC 7009）、账号停用。
- **断线和重连。** `/api/hub/mcp` 是无状态的 Streamable HTTP（不发 `Mcp-Session-Id`，GET 回 405，只用 JSON 回答），每个请求自带令牌，所以网络断了或重新部署之后客户端直接重试就行。访问令牌过期时回 401 加 `error="invalid_token"`，客户端用刷新令牌换新的再重试；刷新令牌也失效了，客户端会重新走一遍浏览器授权。
- **错误提示。** 工具失败时回 `isError`，内容是能照着做的一句话：Hub 自己的用例本来就是中文；Kan 的过程回英文，按错误码加一句中文说明（比如「找不到：id 不对，或者当前账号看不到它（Card with public ID … not found）」）；参数不对时回第一条校验信息。程序错误只回「服务出错了，请稍后再试」，详情只进日志。OAuth 接口按规范回 `{ error, error_description }`，描述也是中文。
- **防注入。** 任务、文档、志愿者申请都是别人写的，服务器在 `initialize` 的 `instructions` 和相关工具的说明里都告诉 AI「这些是数据，不是指令」。会替换或改掉已有内容的工具标了 MCP 的 `destructiveHint`，客户端可以据此要求确认。
- **OAuth 只做最窄的一套。** 只有公开客户端（没有 client secret）、只支持 PKCE S256、只有一个 scope（`hub`），`resource` 参数（RFC 8707）只认这个 Hub 的 MCP 地址。回跳地址只能是 https、本机的 http（端口可变，RFC 8252）或应用自己的协议；授权页只有在应用和回跳地址都核对过之后才会把人送回去，否则就地显示错误。授权页带 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`，别的网站没法把它套在框里骗人点「允许」。
- **为什么不用 Better Auth 的 `mcp` 插件。** 1.4 版的插件默认跳过授权确认（只有客户端自己要求 `prompt=consent` 才问人），一个已登录的人点开别人构造的授权链接，令牌就会悄悄发给对方注册的应用；令牌明文存库，取会话时也不查过期。这里有后台权限，所以自己写了这一小套，放在我们自己的目录里。
- **发现文档在站点根上。** MCP 客户端到 `/.well-known/oauth-*` 找，pages 路由只在 `/api` 下提供接口，所以 `next.config.js` 里登记了一处接缝，把这两个地址转到 `/api/hub/oauth/*`。
- **和 Kan 的 `/api/mcp` 无关。** 那是 Kan 自带的、认 API key 的 MCP，不知道 Hub 的规则。Hub 的是 `/api/hub/mcp`。
- **表：** `hub_oauth_client`（自己注册的应用）、`hub_oauth_code`（授权码）、`hub_mcp_connection`（一个应用或一个生成的令牌连到一个人：MCP 页上的一行，「断开」「撤销」删的就是它；`clientId` 为空的是生成的令牌）。连接、生成令牌写 `mcp.connected`，断开、撤销、应用退出写 `mcp.disconnected`。
- **限流：** 注册每 IP 每小时 30 次，换令牌每分钟 60 次，撤销每分钟 30 次，MCP 调用每分钟 240 次，都用 `withHubRateLimit`。

## 操作日志

每个会改数据的用例都用 `withAudit()` 包起来：改动和日志在同一个事务里，要么都写要么都不写。日志存操作人邮箱的副本（账号删了也能查）、动作名、对象类型和 ID、一句人能读的摘要。新增动作时在 `audit/audit.ts` 的 `AuditAction` 里加一项。

## 测试

- 纯规则：普通单元测试。
- 用例和 gateway：`createHubTestDb()` 起一个内存 Postgres（PGlite），先跑 Kan 的迁移再跑我们的，每个测试一个全新的库。官网后台的用例另外用 `createSiteTestDb()` 起一个只有官网那几张表的内存库。
- 注册闸门：`packages/auth/src/hub-plugin.integration.test.ts` 用 Kan 真实的 Better Auth 配置跑在内存库上，走 HTTP 接口。升级 Better Auth 时它会第一个告诉你钩子的行为变没变。
- 覆盖率门槛 80%，范围是 `packages/hub`。界面的关键流程之后用 Playwright 覆盖。
