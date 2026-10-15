/**
 * 填充一批示例读书笔记，方便第一次打开时就能看到效果。
 *   node --no-warnings scripts/seed.mjs            # 默认写进 http://127.0.0.1:7788
 *   BASE=http://127.0.0.1:9000 node scripts/seed.mjs
 *
 * 数据全部是演示用的示例内容，想清空直接删除 data/notes.db 即可。
 */
import { deflateSync, crc32 } from 'node:zlib';

const BASE = process.env.BASE || 'http://127.0.0.1:7788';

const pad = (n) => String(n).padStart(2, '0');
const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** [距今天数, 粘贴原文] —— 刻意写得像真实读书时随手粘下来的样子 */
const SEED = [
  [196, `#认知 #决策
《思考，快与慢》 作者：丹尼尔·卡尼曼
类型：摘录
页码：P32
> 直觉是有代价的：它让我们在熟悉的情境里高效，在陌生的情境里自信地犯错。
日期：${dayOffset(196)}`],

  [191, `《思考，快与慢》
今天读到系统1和系统2的分工，突然意识到自己写读书笔记的过程其实是在给系统1的判断做系统2的复核：不写下来，就永远不知道自己其实没想清楚。 #认知
日期：${dayOffset(191)}`],

  [180, `《思考，快与慢》 页码：P78
疑问：锚定效应为什么在完全无关的数字上依然有效？如果锚点明显荒谬，为什么判断还是会被拉偏？
日期：${dayOffset(180)}`],

  [168, `#决策
《思考，快与慢》 P112
摘录：损失厌恶让我们在面对确定的损失时变得冒险，在面对确定的收益时变得保守 —— 明明是同一个人，风险偏好却随措辞翻转。
作者：丹尼尔·卡尼曼
日期：${dayOffset(168)}`],

  [150, `#决策 #沉没成本
沉没成本那一段读得心里发凉：我们坚持一件已经做错的事，往往不是因为还看好它，而是因为承认错了太疼。真正该问的不是"我已经投入了多少"，而是"如果今天从零开始，我还会选它吗"。
日期：${dayOffset(150)}`],

  [140, `《反脆弱》 作者：纳西姆·塔勒布
类型：摘录
页码：P15
> 风会熄灭蜡烛，却能使火越烧越旺。对随机性、不确定性和混沌也是一样：你要利用它们，而不是躲避它们。
#反脆弱
日期：${dayOffset(140)}`],

  [132, `#反脆弱
《反脆弱》 P203
摘录：杠铃策略 —— 把绝大部分资源放在极端安全的地方，同时把一小部分放在极端激进的地方，避免"中等风险"这种看起来稳妥、实则最脆弱的配置。
日期：${dayOffset(132)}`],

  [126, `《反脆弱》
想法：反脆弱的系统和"稳健"的系统不是一回事。稳健只是抗打击，反脆弱要能从打击中获益。所以关键是看这个系统有没有把波动当作信息来吸收的机制。
日期：${dayOffset(126)}`],

  [118, `《反脆弱》 第 5 章
疑问：怎么判断一个系统到底是反脆弱还是仅仅在硬撑？靠事后结果判断会不会太晚？
日期：${dayOffset(118)}`],

  [112, `#习惯 #复利
《原子习惯》 作者：詹姆斯·克利尔
页码：p.18
摘录：习惯是自我提高的复利。每天进步 1%，一年后你会变强 37 倍；每天退步 1%，一年后你会几乎归零。
日期：${dayOffset(112)}`],

  [104, `《原子习惯》 p.54
#习惯
摘录：习惯叠加 —— 把新习惯挂在已有习惯后面："继〔现有习惯〕之后，我会〔新习惯〕"。诀窍是选一个已经稳定到不需要意志力的动作作为锚点。
日期：${dayOffset(104)}`],

  [98, `《原子习惯》
想法：真正持久的改变不是"我要每天读 30 页"，而是"我是一个每天会读几页的人"。行为是身份的证据，不是身份的原因。
#习惯
日期：${dayOffset(98)}`],

  [92, `待办：把"读到就贴进来"变成习惯，挂在每天晚饭后泡茶之后。
#习惯
日期：${dayOffset(92)}`],

  [86, `#叙事 #历史
《人类简史》 作者：尤瓦尔·赫拉利
页码：第 2 章
摘录：任何大规模人类合作的根基，都在于某种只存在于集体想象中的虚构故事。
日期：${dayOffset(86)}`],

  [80, `《人类简史》 第 1 章
摘录：认知革命让智人获得了讲述虚构故事的能力，于是陌生人之间也能围绕共同的神话、货币、国家展开协作。这是智人胜过尼安德特人的关键。
#叙事 #历史
日期：${dayOffset(80)}`],

  [74, `《人类简史》
想法：如果"自我"本身也是一个被讲述出来的故事，那写读书笔记其实是在参与对自己叙事的编辑，而不只是记录信息。
#叙事
日期：${dayOffset(74)}`],

  [66, `《人类简史》 第 2 章
疑问：虚构的故事为什么能组织起大规模协作，而真实的规则反而不行？是因为虚构可以随时修改、不需要成本吗？
#叙事 #历史
日期：${dayOffset(66)}`],

  [58, `#阅读方法
《如何阅读一本书》 作者：莫提默·艾德勒
页码：P43
摘录：主动阅读的读者在阅读时要提出四个问题：这本书整体在谈什么？作者细部说了什么、怎么说的？说得有道理吗？这本书跟我有什么关系？
日期：${dayOffset(58)}`],

  [46, `#阅读方法
《如何阅读一本书》 P289
摘录：主题阅读是最主动、也最费力的一种阅读。读者要围绕一个主题，把多本书放在一起读，而不是被动地接受某一本书给出的框架。
日期：${dayOffset(46)}`],

  [38, `《如何阅读一本书》
想法：主题阅读最难的地方在于"建立中性词汇"——每本书用的词不一样，硬套其中一本的术语就会失真。这和我在笔记里统一标签其实是同一件事。
#阅读方法
日期：${dayOffset(38)}`],

  [30, `#反脆弱 #决策
《反脆弱》 P167
摘录：试错是一种期权。每一次小成本的尝试，买的不是结果，而是"知道结果"的权利；只要损失有下限、收益没上限，试错就永远划算。
日期：${dayOffset(30)}`],

  [21, `#复利 #阅读方法
想法：读书笔记真正的复利不在"记了多少"，而在于同一批材料被反复重新组合：今天按主题看，明天按时间看，后天它们之间长出新的连接。零散笔记的价值随时间上升，前提是它们能被低成本地重新取用。
日期：${dayOffset(21)}`],

  [12, `#决策
《思考，快与慢》 P289
摘录：前景理论：人对得失的判断依据的不是绝对水平，而是相对于参照点的变化。改变参照点，就能改变同一个人对同一件事的偏好。
作者：丹尼尔·卡尼曼
日期：${dayOffset(12)}`],

  [5, `#阅读方法 #复利
小结：最近半年试下来，有效的读书笔记流程是三步 —— 读的时候只做一件事：把触动我的句子和当时的想法一起贴进来；每周按标签看一眼，把零散的想法补一句话；每读完一本书或攒够一个主题，就汇总成一篇读书笔记。
日期：${dayOffset(5)}`],

  [2, `#反脆弱
《反脆弱》 P61
摘录：如果你拥有一个会随波动而受益的结构，那么"不确定性"就不再是需要防范的敌人，而是需要被请进来的客人。
日期：${dayOffset(2)}`],
];

/* ------------------------------------------------------------------ 示例图片 */

/**
 * 手搓一张 PNG（零依赖，只用 node:zlib）。
 * 示例数据里放图，是为了让第一次打开的人直接看到「截图和文字一起存」是什么样子。
 */
function makeDemoImage(w = 600, h = 320) {
  const px = Buffer.alloc(h * (1 + w * 3));   // 每行开头一个滤波字节
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * (1 + w * 3) + 1 + x * 3;
    px[p] = r; px[p + 1] = g; px[p + 2] = b;
  };
  const rect = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, r, g, b);
  };

  const INK = [71, 85, 105];
  const BAR = [148, 163, 184];
  const LINE = [99, 102, 241];

  // 淡淡的斜向渐变底
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      set(x, y, Math.round(250 - 12 * t), Math.round(251 - 10 * t), Math.round(254 - 8 * t));
    }
  }
  // 标题条
  rect(40, 34, 40 + 190, 44, INK);
  // 三个方框：脆弱 / 稳健 / 反脆弱
  const boxes = [[40, 90], [230, 90], [420, 90]];
  for (const [bx, by] of boxes) {
    rect(bx, by, bx + 140, by + 140, [203, 213, 225]);            // 边框
    rect(bx + 3, by + 3, bx + 137, by + 137, [255, 255, 255]);    // 底色
    rect(bx + 18, by + 22, bx + 96, by + 30, INK);                // 小标题
    for (let i = 0; i < 5; i++) {                                  // 几行“文字”
      const ly = by + 48 + i * 16;
      rect(bx + 18, ly, bx + 18 + (i % 2 ? 74 : 102), ly + 6, BAR);
    }
  }
  // 框之间的连线（示意“波动进来以后各自怎么反应”）
  for (const y of [150, 168]) {
    rect(180, y, 230, y + 2, LINE);
    rect(370, y, 420, y + 2, LINE);
  }
  // 底部结论条：反脆弱那一列加粗
  rect(420, 258, 560, 268, INK);
  rect(40, 258, 180, 266, BAR);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // 每通道 8 位
  ihdr[9] = 2;    // 真彩色 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 那条「图文混排」的示例笔记 */
const imageNote = (url) => `#反脆弱 #阅读方法
《反脆弱》 第 5 章
读完顺手画了张图，把三种系统面对波动时的反应摆在一起看：
![](${url})
画的时候才发现，「能承受」和「能受益」中间差着一整个量级：稳健只是不被波动打死，反脆弱是要把波动当饭吃。
日期：${dayOffset(3)}`;

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${text.slice(0, 200)}`);
  return data;
}

try {
  const health = await req('/api/health');
  if (health.notes > 0 && !process.env.FORCE) {
    console.log(`\n数据库里已经有 ${health.notes} 条笔记了，为避免混入示例数据，已跳过。`);
    console.log('确实想加示例数据的话：FORCE=1 node --no-warnings scripts/seed.mjs\n');
    process.exit(0);
  }

  const text = SEED.map(([, t]) => t).join('\n---\n');
  const preview = await req('/api/notes/preview', { method: 'POST', body: { text, mode: 'auto' } });
  const saved = await req('/api/notes/bulk', { method: 'POST', body: { blocks: preview.blocks, allowDuplicate: false } });

  console.log(`\n已写入 ${saved.createdCount} 条示例笔记（跳过重复 ${saved.duplicateCount} 条）`);
  if (saved.failed?.length) console.log(`失败 ${saved.failed.length} 条`);

  // 再单独插一条带图的：演示「截图 + 文字一起存」
  try {
    const png = makeDemoImage();
    const up = await req('/api/attachments', {
      method: 'POST',
      body: {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        name: '三种系统面对波动.png',
        width: 600,
        height: 320,
      },
    });
    const text = imageNote(up.attachment.url);
    const pv = await req('/api/notes/preview', { method: 'POST', body: { text, mode: 'auto' } });
    const imgSaved = await req('/api/notes/bulk', { method: 'POST', body: { blocks: pv.blocks, allowDuplicate: false } });
    if (imgSaved.createdCount) console.log(`已附带 1 条带图的示例笔记（${Math.round(png.length / 1024)}KB 图片，直接存在数据库里）`);
  } catch (err) {
    console.log(`示例图片没插进去（不影响其它数据）：${err.message}`);
  }

  const facets = await req('/api/facets');
  console.log(`现有：${facets.totals.total} 条笔记 · ${facets.topics.length} 个主题 · ${facets.tags.length} 个标签`);
  console.log(`主题标签：${facets.tags.filter((t) => t.kind === 'topic').map((t) => `#${t.name}(${t.count})`).join(' ')}`);
  console.log('\n打开 ' + BASE + ' 就能看到了。想清空数据：删掉 data/notes.db 即可。\n');
} catch (err) {
  console.error(`\n写入失败：${err.message}`);
  console.error('请确认服务已经启动（npm start）。\n');
  process.exit(1);
}