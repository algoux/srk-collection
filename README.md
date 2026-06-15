# srk-collection

这个仓库是 algoUX 官方维护的 [榜单合集](https://rl.algoux.cn/collection/official)。

如果你持有我们缺失的榜单数据，欢迎参与贡献！

## 使用本数据

我们整理的数据完全开源，在不违反协议的前提下可自由用于社区或商业项目。

如要使用数据，可以参阅 [srk 文档](https://srk.algoux.org) 了解 srk 数据格式与工具库的用法，其包含对 JS/TS/Python/Go 开发者的优先支持。

对于直接使用数据的场景，我们建议您在项目中标注数据来源；对于二次加工、修订和补全，相较于本数据在实质内容上发生变化的衍生数据，应当按相同协议开源处理后的数据部分（不包括上层应用源码）。

欢迎社区与我们共同建设开放生态，促进行业发展。

### 使用 srk-collection 的社区项目

尽情探索这些令人惊叹的社区项目！它们用到了本仓库的数据构建应用：
- [xcpc-vp-board](https://github.com/cqh6/xcpc-vp-board)
- [xcpc-elo](https://github.com/Zzzzzzyt/xcpc-elo)
- [XIPF](https://github.com/dbywsc/XIPF)
- [xcpc · rating](https://github.com/Hei-MaoM/xcpcrating)

如果你也在使用 srk-collection 的数据构建项目，欢迎联系我们或在本仓库提交 Issue/PR，我们很乐意将你的项目添加到列表中。

## 如何贡献数据

### 方式一：fork 本仓库修改，提交 PR

目录结构示例说明：

```plain
official/
  config.yaml # 榜单目录树配置（若涉及目录改动，需要修改）
  ccpc/ # 榜单数据目录，和配置及前端呈现的目录结构对应
    ccpc2020/
      ccpc2020final.srk.json
```

不知道如何生成 srk 数据文件？你可以尝试：
- 参阅 [srk 文档](https://srk.algoux.org) 了解 srk 数据格式与工具库的用法
- 直接使用我们维护的各类榜单爬虫程序：[spidercraft](https://github.com/algoux/rank-spider/tree/master/spidercraft)
- 在 [RankLand](https://rl.algoux.cn) 联系我们，我们将很乐意提供协助

### 方式二：提交 Issue

如果你不熟悉 git 操作，或者只是想提供手头的补充数据资料，欢迎提交 [Issue](https://github.com/algoux/srk-collection/issues/new)，我们会尽快回复并完成数据收录和更新。
