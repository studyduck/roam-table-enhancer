# Builtin Roam Table Editable Notes

这个版本增强的是 Roam 原生 `{{table}}` / `{{[[table]]}}`，不是自定义表格渲染器。

## 已固化的关键事实

### 1. 原生 `{{table}}` 的 backing 结构在当前测试图里是 path-based

在当前已验证的 Roam 图里：

- 可见表格的每一行，对应宿主 marker block 下的一条 root-to-leaf path
- 不是“宿主下面每个子 block 就是一整行”这种 sibling-row 模型
- 不同可见行之间可以共享前缀 block
- 因此同一个 backing cell UID 可以合法地出现在多个可见单元格位置

这意味着：

- native table 解析必须按 path 提取行
- DOM 映射不能假设 `cellUid` 全局唯一
- 选择态、编辑态、Tab 导航等 visible-cell identity 应优先按 `rowIndex + colIndex` 判断，再用 UID 做一致性校验

### 2. 原生 table DOM 不能被插件当成自定义渲染层来改写

这次实际踩到的回归是：

- 单元格进入编辑时，如果直接 `cell.innerHTML = ''`
- 或者保存/取消时把原先缓存的 HTML 再写回去
- 虽然短时间内看起来可以编辑和保存
- 但在 blur / remount / Roam 自己重新渲染后，宿主 `{{table}}` 可能进入 `Failed to render`

根因可以理解为：

- 原生 `<td>` 内容是 Roam 自己维护的渲染结果
- 插件直接替换、清空、重建这段 DOM，会破坏 Roam 对 native table 的渲染预期
- blur 后保存 + remount 时，这种破坏更容易暴露出来

## 当前采用的安全思路

### 编辑 UI

现在的编辑实现遵循：

- 不替换原生 cell DOM
- 不清空 `<td>`
- 不恢复缓存下来的旧 HTML
- 只在 cell 内临时追加一个 overlay `textarea`
- 结束编辑时只移除这个 textarea

也就是说：

- Roam 渲染的原生 DOM 始终保留
- 插件只是叠加一个临时编辑层

### 保存流程

保存顺序固定为：

1. 调用 `window.roamAlphaAPI.updateBlock(...)` 更新真实 backing cell block
2. 移除 overlay editor
3. 重新 pull 当前 table state
4. 重新把可见 native table DOM 映射回 backing blocks
5. 恢复选中态 / 导航目标

原则是：

- Roam blocks 才是事实来源
- native table DOM 只是展示层
- 插件永远不要把编辑中的 `<td>` HTML 当作 source of truth

## 编辑态垂直对齐的额外结论

这次又确认了一个容易回归的细节：

- Roam 原生 table 的高单元格里，短文本视觉上接近垂直居中
- 但 overlay `textarea` 如果简单铺满整个 cell 高度，文字会因为 textarea 自身的文本流规则而贴近顶部
- 结果就是：默认态看起来居中，进入编辑态后却突然顶部对齐，体验不连续

当前稳定方案是：

- `textarea` 不强制占满整个 cell 高度
- 先按内容计算编辑框真实需要的高度
- 再根据 `cellHeight` 计算一个 `topOffset`
- 当 cell 比内容更高时，把整个 textarea 在 cell 内垂直居中

也就是说，编辑态的“居中”不是靠把文字在 textarea 内做特殊排版，而是：

- 让 textarea 保持内容高度
- 再把 textarea 整体居中放进 cell

这样对单行/短文本更稳定，也不会破坏多行内容的自然扩展。

## 新建表格与深列支持的额外结论

这次又确认了两个很容易回归的事实：

### 1. 新创建的原生 `{{table}}` 不能只按“首次 mount 成功”判断已经稳定

原因是：

- 新建 native table 时，Roam 的 visible DOM、backing blocks、query / pull 结果并不一定在同一拍稳定
- 插件可能先读到一个“结构还没长全”或“DOM 文本已经更新、但 pull state 还是旧值”的中间态
- 如果这时实例已经被当成 live，后续就可能出现：
  - 只有部分单元格可编辑
  - 某个单元格可点，但进入编辑时初始值是空

当前稳定思路是：

- 不只检查实例的 DOM 连接状态
- 还要检查当前 rendered profile 是否仍与缓存 state profile 一致
- 还要检查已映射 cell 的当前 DOM 文本是否仍与缓存 state 文本一致
- 只要 profile 或文本不一致，就把实例视为 stale，重新 pull + remap

也就是说：

- native table 实例的“活着”不等于 DOM 还连着
- 还必须保证结构和文本都没有落后于 Roam 的当前渲染

### 2. 原生 `{{table}}` 的列数本质上受 backing path 深度影响，不是普通二维 schema 的固定列数

在当前测试图里：

- 每个 visible row 对应一条 root-to-leaf path
- 列数就是 path 上 block 的深度
- 因此列很多时，真正限制解析能力的不是 DOM，而是 pull / 遍历的深度上限

如果深度上限太小，就会出现：

- DOM 里后面的列已经渲染出来了
- 但插件 state 没有 pull 到这些更深层 cell blocks
- 结果就是第 13 列及之后的单元格无法映射，也无法编辑

当前稳定思路是：

- 不要把 native table tree pull 深度写死成接近默认小表格的值
- pull 深度上限和 path 遍历保护上限要一起放宽，并保持一致
- 当前实现用统一的 `MAX_NATIVE_TABLE_DEPTH` 控制这两个地方

## 单元格短暂滚动条的额外结论

这次还确认了一个和编辑态布局相关的细节：

- 点击单元格后出现的那条只能上下滚动几像素的滚动条，不一定来自 `textarea`
- 更可能是 native `<td>` 本身在进入编辑态后被额外撑高了一点，从而让 cell 自己产生了短暂溢出

当前较稳定的处理思路是：

- overlay `textarea` 继续保持 `position: absolute`
- 编辑态下，原生 cell 的其他子内容不仅要 `visibility: hidden`
- 还要尽量退出正常排版流，例如改成绝对定位并禁用 pointer events
- 同时让 editing cell 自身 `overflow: hidden`

这样可以尽量避免：

- 隐藏中的原生内容仍参与布局
- textarea overlay 再叠加后把 cell 多撑开几像素
- 最终由 cell 自己冒出一个短暂的小滚动条

## 防回归规则

以后如果继续改这个文件，请优先遵守下面几条：

1. 不要把 native `<td>` 当成可完全接管的容器
2. 不要用 `innerHTML = ''` 进入编辑态
3. 不要在 teardown 时把缓存 HTML 写回 cell
4. 不要假设一个 `cellUid` 只对应一个 visible cell
5. visible cell 的身份判断优先使用 `rowIndex + colIndex`
6. 保存后始终重新 pull + remap，不要只靠本地 DOM patch 维持状态
7. 新创建的 native table 不能只靠“首次 mount 成功”判断稳定，实例活性还要校验 profile 和 cell 文本是否过期
8. native table 的深列支持受 backing path 深度影响，pull 深度和 path 遍历深度上限必须同步维护
9. 编辑态如果又出现短暂小滚动条，先排查是不是 `<td>` 自身溢出，而不是先假设是 `textarea` 内部滚动
10. 结构变更入口如果先把实例标记为 `mutating`，再复用同一个禁用 guard 做执行前校验，必须允许这次“当前正在执行的 mutation”跳过自我阻塞；否则 `Add row` / `Add Column` 这类操作会在真正写入前就被自己拦下，报出 `Table structure is updating.`
11. 后台 scan / remount 不能在实例处于编辑态时把“插件自己加上的 overlay textarea / 编辑态 class”误判成 stale DOM；否则用户刚点进单元格，scan 就会立刻 refresh/remount，把焦点打掉。

## 编辑态被后台重挂打断的问题

这次又确认了一个很容易回归的问题：

- 用户点击单元格进入编辑时，插件会在 native cell 里追加 overlay `textarea`
- 同时 cell 还会进入编辑态 class
- 这些变化会触发 `MutationObserver` 和后续 scan
- scan 又会走到实例活性检查和 `refreshMountedInstance(...)`
- 如果这时把“编辑态下插件自己加上的 DOM / class 变化”当成 stale 信号
- 就会立即 remount 当前 table instance
- 外部现象就是：单元格先获得焦点，又立刻失去焦点

根因可以理解为：

- 编辑态会故意对 native cell 做一层临时 overlay
- 但后台 scan 的职责本来是处理“Roam 自己重渲染后实例真的过期了”
- 如果不区分“插件主动制造的编辑态临时变化”和“真实 stale / remount 信号”
- scan 就会在用户刚进入编辑时把当前实例错误重挂

当前稳定方案是：

- 编辑态下仍允许正常输入、保存、blur、refresh
- 但后台 scan 经过 `refreshMountedInstance(...)` 时
- 如果当前实例已经处于 `instance.editing`
- 且这次不是显式 `force` 刷新
- 就直接跳过这次 remount

也就是说：

- stale 检测仍然保留
- 但不能把插件自己在编辑态增加的 overlay DOM 当成需要立刻重挂的证据
- “编辑中的实例”需要比普通静态实例多一层保护，避免焦点被后台扫描打断

## 结构更新自锁问题

这次行列控制功能里又确认了一个很容易回归的问题：

- `runStructuralMutation(...)` 在进入真正写入前，会先把 `instance.mutating = true`
- 这样做本身是对的，因为要防止并发结构修改
- 但如果随后又调用 `getStructureMutationDisabledReason(...)` 做执行前重检
- 而这个 guard 又无条件检查 `instance.mutating`
- 就会把当前这一次已经开始的 mutation 自己拦掉
- 外部现象就是：右键点 `Add row` 没反应，控制台报 `Table structure is updating.`

根因可以理解为：

- `mutating` 这个标志同时承担了两个角色：
  - 对外阻止新的并发结构操作
  - 对内表示“当前这次操作已经进入 mutation 流程”
- 如果内外都走同一个 guard，但不区分“别的 mutation”还是“我自己这次 mutation”
- 那么 guard 就会把当前操作误判成冲突中的外部操作

当前稳定方案是：

- 对菜单禁用态、用户点击前校验，继续正常检查 `instance.mutating`
- 但在 `runStructuralMutation(...)` 内部，进入 mutation 之后再做安全重检时
- 要允许忽略这次由自己设置的 `mutating` 标志
- 当前实现通过给 `getStructureMutationDisabledReason(...)` 传入 `{ ignoreMutating: true }` 实现

也就是说：

- `mutating` 仍然保留串行化保护作用
- 但内部执行路径不能被自己的锁反向拦截
- 结构更新的 guard 需要区分“阻止新的并发请求”和“允许当前已持锁请求继续执行”这两种语义

## 行列增删功能的实现思路

这次行列控制功能的需求和语义已经直接固化在本文档中，目标不是额外维护一套 schema，而是直接对 Roam 原生 `{{table}}` 的 backing blocks 做结构修改。

### 右键入口与菜单项

当前交互入口是：

- 用户对某个已映射的 native table 单元格点右键
- 插件弹出自定义 context menu
- 菜单包含四个动作：
  - `Add row`
  - `Add Column`
  - `Delete row`
  - `Delete Column`

菜单只是触发层；真正的事实来源仍然是 backing blocks。执行结构修改时，必须走 `createBlock(...)` / `updateBlock(...)` / `deleteBlock(...)`，然后重新 pull + remap，不能靠 DOM patch 假装成功。

### 需求所对应的基础结构示例

文档里的基础示例是：

```text
{{table}}
    - AA
        - BB
            - CC
    - DD
        - EE
            - FF
    - GG
        - HH
            - II
```

在当前测试图里，它会渲染成一个 3 行 3 列的原生表格：

- 第 1 行：`AA`、`BB`、`CC`
- 第 2 行：`DD`、`EE`、`FF`
- 第 3 行：`GG`、`HH`、`II`

这里采用的语义仍然是前面已经固化过的 path-based 模型：

- 每个 visible row 对应一条 root-to-leaf path
- 行操作本质上作用在该 row 对应的顶层 root 子树
- 列操作本质上作用在每一行 path 上的第 N 个节点

### 删除行语义

删除行时，先判断当前右键命中的 visible row：

- 如果是第 1 行，不允许删除，因为第 1 行作为表头数据
- 如果不是第 1 行，则允许删除
- 删除方式不是“只清空某个单元格”，而是直接删除该 visible row 对应的根节点及其整棵子树

按文档示例理解：

- 右键 `BB` 再点 `Delete row`：因为 `BB` 在第 1 行，所以不允许删除
- 右键 `EE` 再点 `Delete row`：因为 `EE` 在第 2 行，所以删除第 2 行对应 root `DD` 及其所有子节点
- 右键 `II` 再点 `Delete row`：因为 `II` 在第 3 行，所以删除第 3 行对应 root `GG` 及其所有子节点

也就是说：

- 删除行 = 删除该 visible row 的 root subtree
- 不是删单个 cell block
- 也不是只清空字符串

### 删除列语义

删除列时，先判断当前右键命中的 visible column：

- 如果是第 1 列，不允许删除，因为第 1 列作为表头数据
- 如果不是第 1 列，则允许删除

删除列的语义分两种：

#### 1. 删除的就是最后一列

如果当前列已经是最后一列，那么不需要做左移：

- 直接把每一行最后一列对应的 tail node 删除即可

按文档示例：

- 右键 `CC` 再点 `Delete Column`
- 因为它在第 3 列，并且第 3 列已经是最后一列
- 所以直接删除每一行的最后一个节点
- 最终表格变成：

```text
{{table}}
    - AA
        - BB
    - DD
        - EE
    - GG
        - HH
```

#### 2. 删除的不是最后一列

如果删除的是中间列，则不能直接删当前列节点，否则会把后面的列整体截断。正确语义是：

1. 先把当前这一列对应的原始数据清空
2. 再把当前列后面的所有列数据依次向前移动一位
3. 最后把最后一列已经空出来的 tail node 删除

按文档示例，右键 `EE` 删除第 2 列时，可以理解成：

先清空第 2 列：

```text
{{table}}
    - AA
        -
            - CC
    - DD
        -
            - FF
    - GG
        -
            - II
```

然后把后面的列往前移：

```text
{{table}}
    - AA
        - CC
            -
    - DD
        - FF
            -
    - GG
        - II
            -
```

最后删除每一行最后一个空 tail node，得到：

```text
{{table}}
    - AA
        - CC
    - DD
        - FF
    - GG
        - II
```

也就是说：

- 删除中间列 = 后续列左移 + 删除尾节点
- 不是简单把当前列节点整列删掉

### 增加行语义

增加行的需求是：

- 在当前点击单元格所在行的后面插入新行
- 新行不是加在最底部的任意位置，而是紧跟当前行
- 新行的 backing 结构要是一条与当前表格列数一致的空链

按文档示例，右键 `DD` 后点击 `Add row`，结果应变成：

```text
{{table}}
    - AA
        - BB
            - CC
    - DD
        - EE
            - FF
    -
        -
            -
    - GG
        - HH
            - II
```

也就是说：

- 增加行 = 在当前行 root 后插入一个新的顶层 root
- 然后继续向下创建空字符串 child，直到深度与当前列数一致

### 增加列语义

增加列的需求是：

- 在当前点击单元格所在列的后面插入新列
- native table 没有独立的 column schema，所以“加列”本质上是给每一行 path 增加一个新的链位置

正确语义分两步：

#### 1. 先给每一行追加一个新的尾空节点

按文档示例，右键第 1 列里的 `DD` 后点击 `Add Column`，首先每一行末尾都要补一个新的空节点：

```text
{{table}}
    - AA
        - BB
            - CC
                -
    - DD
        - EE
            - FF
                -
    - GG
        - HH
            - II
                -
```

#### 2. 再从尾部开始，把值逐列向后移动，直到目标列后方空出来

第一次移动后：

```text
{{table}}
    - AA
        - BB
            -
                - CC
    - DD
        - EE
            -
                - FF
    - GG
        - HH
            -
                - II
```

第二次移动后：

```text
{{table}}
    - AA
        -
            - BB
                - CC
    - DD
        -
            - EE
                - FF
    - GG
        -
            - HH
                - II
```

这样就在第 1 列后面空出了一列新列。

也就是说：

- 增加列 = 先 append blank tail to all rows
- 再把尾到目标列之间的值逐步右移
- 最终在目标列后方留下一个新的空列

### 当前实现层面的约束

虽然编辑能力已经支持 path-based native table，但结构修改比普通编辑更敏感，所以当前实现仍然遵守更保守的边界：

- 右键菜单可以出现
- 但只有当表格结构能被稳定定位为“每个 visible row 都对应独立线性链”时，行列结构操作才会启用
- 如果出现 shared-prefix、分叉、链深无法稳定定位等情况，则结构操作要禁用，不做猜测性写入

原则是：

- 编辑可以尽量兼容 path-based native table
- 行列增删只能在语义明确、安全可定位时执行
- 一旦执行，必须始终以 Roam blocks 为事实来源，写完后 refresh + remap

## 当前相关代码位置

- path-based parser: `extension.js`
- visible-cell identity / duplicate UID handling: `sameSpec(...)`, `findMappedEntry(...)`
- safe overlay edit entry: `beginEdit(...)`
- safe edit teardown: `teardownEditingView(...)`
- save then remap flow: `commitEdit(...)`
- context menu entry / actions: `handleTableContextMenu(...)`, `handleContextMenuAction(...)`
- structure analysis / availability: `analyzeNativeTableStructure(...)`, `getContextMenuAvailability(...)`, `getStructureMutationDisabledReason(...)`
- serialized structural mutation: `runStructuralMutation(...)`
- row operations: `addNativeTableRow(...)`, `deleteNativeTableRow(...)`
- column operations: `addNativeTableColumn(...)`, `deleteNativeTableColumn(...)`, `shiftColumnsLeft(...)`, `shiftColumnsRight(...)`
