# 离线词典与样例补充

`english-chinese.sqlite3` 是可直接随应用分发的离线英汉词典索引，包含 768,739 个有中文释义的词条，来自 ECDICT，另有从其 exchange 字段构建的词形索引。

- 上游：https://github.com/skywind3000/ECDICT
- 本次数据分发来源：npm `ecdict@0.0.4` 的 `package/assets/ecdict.csv`（只提取数据，没有执行该包代码）
- 分发项目：https://github.com/yinyanfr/ecdict
- npm 压缩包 SHA-1：`aadfa6e46ed9c586144a3f749d585111168ec5f2`
- 原 CSV SHA-256：见 `english-chinese.json`
- 许可证：MIT，见 `ECDICT-LICENSE.txt`
- 重建：`python scripts/build_dictionary.py path/to/ecdict.csv backend/assets/english-chinese.sqlite3`

`phrases.json` 是本应用编写的常见搭配补充词库。`sample_explanations.json` 是两份样例练习的逐选项简要解释，按练习编号、题号及 A-D 顺序保存；不作为其他题目的通用答案库。

离线词典提供词条释义，不声称覆盖任意自由组合的词组或整句翻译。未收录表达、整句翻译和语境释义由用户配置的 DeepSeek 接口提供，结果明确标注模型来源并在本机缓存。
