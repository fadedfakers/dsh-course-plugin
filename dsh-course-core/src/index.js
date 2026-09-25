export * from './host.js'
export * from './prompt.js'
// 缓存层：派生数据的加速（课程树 / 教案存在性 / 提交版本清单）。
// 单一事实来源仍是磁盘原始文件，缓存条目按来源 mtime+size 失效。
export * from './cache.js'
// 教案自动补全：骨架提取、课时锚点、草稿区、索引重建、大纲体检。
// 教师端主要用它；学生端只间接依赖（教案是否存在、验收标准是否齐）。
export * from './plan.js'
// 人的身份：本机学号、学生自报信息、老师名册、显示名、改学号时的搬迁。
// 两端都用 —— 学生端写、教师端读；显示名的优先级必须只有一处定义，
// 否则「老师看到的是名册里的名字还是学生自己填的」会两边说法不一。
export * from './people.js'
// zip 读取（学生交整个项目文件夹时用）：只读、只用内置 zlib、有体积与路径安全上限。
export * from './zip.js'
// 就绪清单：装完插件先告诉用户「还差哪几件事」，而不是让他自己找。
// 这几件事任一缺失，症状都是「面板打不开 / 答不出来」，从界面上分不出是哪一件。
export * from './readiness.js'
// 材料归位建议引擎：老师上传课程文件时，只产出「可改的清单」，绝不自动归位。
export * from './materials.js'
// L1「可配置」：章节名/目录名/受控词表/教案骨架都从课程配置读，读不到用内置默认值。
// 默认值就是当前这门课的形状 —— 所以老工作区一行都不用改。
export * from './layout.js'
// 仓库管理（发布页）：仓名 slug、remote 解析、状态读取、无 Token 时的手动步骤。
// 状态直接从 .git/config 读，不 spawn git —— 只要三件事：有没有仓、remote 指向哪、哪个分支。
export * from './repo.js'
// 起子进程并**收回输出**（git / 发布工具）。用它而不是 spawnSync 的 encoding：
// 沙箱不给管道，带 encoding 的 spawnSync 一律 EPERM，而且**不抛异常** ——
// 表现为「退出码 null + 没有输出」，看起来像 git 自己没说话。详见 run.js 顶部注释。
export * from './run.js'
