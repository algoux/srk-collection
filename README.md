# srk-collection

这个仓库是 algoUX 官方维护的[榜单合集](https://rl.algoux.org/collection/official)。

如果你持有我们缺失的榜单数据，欢迎参与贡献！

## 如何贡献

fork 本仓库修改，然后提交 PR。

目录结构示例说明：

```plain
official/
  config.json # 榜单目录树配置（若涉及目录改动，需要修改）
  ccpc/ # 榜单数据目录，和配置及前端呈现的目录结构对应
    ccpc2020/
      ccpc2020final.srk.json
```

如果你不知道如何生成 srk 数据文件，欢迎在 [RankLand](https://rl.algoux.org) 联系我们，我们很乐意提供协助。
