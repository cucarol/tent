/**
 * Strings Excalidraw's zh-CN pack has not translated yet, worded like the rest of that pack.
 * The build puts them under the upstream pack (scripts/ui-build.mjs), so an upstream translation still wins.
 */
const missing = {
  labels: {
    changeStroke: "更改描边颜色",
    changeBackground: "更改背景颜色",
    arrowhead_crowfoot_many: "鸦爪（多）",
    arrowhead_crowfoot_one: "鸦爪（一）",
    arrowhead_crowfoot_one_or_many: "鸦爪（一或多）",
    more_options: "更多选项",
    arrowtypes: "箭头类型",
    arrowtype_sharp: "直线箭头",
    arrowtype_round: "曲线箭头",
    arrowtype_elbowed: "折线箭头",
    clearCanvas: "清空画布",
    toggleGrid: "切换网格",
    loadScene: "从文件加载画布",
    showFonts: "显示字体选择器",
    theme: "主题",
    link: { hint: "在这里输入或粘贴链接", goToElement: "跳到目标对象" },
    lineEditor: { editArrow: "编辑箭头" },
    followUs: "关注我们",
    discordChat: "Discord 聊天",
    zoomToFitViewport: "缩放以适应视口",
    zoomToFitSelection: "缩放以适应选区",
    zoomToFit: "缩放以适应所有元素",
    installPWA: "在本地安装 Excalidraw（PWA）",
    autoResize: "文本自动调整大小",
    imageCropping: "裁剪图像",
    unCroppedDimension: "裁剪前的尺寸",
    copyElementLink: "复制对象链接",
    linkToElement: "链接到对象",
    wrapSelectionInFrame: "用画框包住选中内容",
  },
  elementLink: {
    title: "链接到对象",
    desc: "点击画布上的形状，或粘贴链接。",
    notFound: "画布上找不到链接的对象。",
  },
  search: {
    title: "在画布上查找",
    noMatch: "没有找到……",
    singleResult: "个结果",
    multipleResults: "个结果",
    placeholder: "查找画布上的文字……",
  },
  buttons: { copyLink: "复制链接", systemMode: "跟随系统" },
  errors: { saveLibraryError: "无法把素材库存入存储。请把素材库保存为本地文件，以免丢失修改。" },
  element: {
    rectangle: "矩形",
    diamond: "菱形",
    ellipse: "椭圆",
    arrow: "箭头",
    line: "线条",
    freedraw: "自由书写",
    text: "文字",
    image: "图像",
    group: "编组",
    frame: "画框",
    magicframe: "线框图至代码",
    embeddable: "嵌入网页",
    selection: "选区",
    iframe: "IFrame",
  },
  hints: {
    dismissSearch: "按 Esc 关闭搜索",
    arrowTool: "点击创建多个点，拖动创建单条线。再按 {{arrowShortcut}} 切换箭头类型。",
    createFlowchart: "按住 CtrlOrCmd 和方向键来创建流程图",
    enterCropEditor: "双击图像或按回车键来裁剪",
    leaveCropEditor: "点击图像外部，或按回车键或 Esc 完成裁剪",
  },
  shareDialog: { or: "或" },
  helpDialog: {
    createFlowchart: "从一个元素创建流程图",
    navigateFlowchart: "在流程图中移动",
    cropStart: "裁剪图像",
    cropFinish: "完成裁剪",
  },
  stats: {
    shapes: "形状",
    fullTitle: "画布与形状属性",
    generalStats: "常规",
    elementProperties: "形状属性",
  },
  toast: {
    copyToClipboardAsSvg: "已将 {{exportSelection}} 作为 SVG 复制到剪贴板\n({{exportColorScheme}})",
    elementLinkCopied: "链接已复制到剪贴板",
  },
  quickSearch: { placeholder: "快速搜索" },
  fontList: {
    badge: { old: "旧版" },
    sceneFonts: "本画布中",
    availableFonts: "可用字体",
    empty: "没有找到字体",
  },
  userList: {
    empty: "没有找到用户",
    hint: {
      text: "点击用户以跟随",
      followStatus: "你正在跟随这位用户",
      inCall: "用户正在语音通话",
      micMuted: "用户的麦克风已静音",
      isSpeaking: "用户正在说话",
    },
  },
  commandPalette: {
    title: "命令面板",
    shortcuts: { select: "选择", confirm: "确认", close: "关闭" },
    recents: "最近使用",
    search: { placeholder: "搜索菜单和命令，也能找到隐藏功能", noMatch: "没有匹配的命令……" },
    itemNotAvailable: "命令不可用……",
    shortcutHint: "打开命令面板：{{shortcut}}",
  },
};

type Pack = { [key: string]: string | Pack };
const isPack = (value: unknown): value is Pack => typeof value === "object" && value !== null;

function under(base: Pack, top: Pack): Pack {
  const out: Pack = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const below = out[key];
    out[key] = isPack(value) && isPack(below) ? under(below, value) : value;
  }
  return out;
}

/** The upstream pack with the missing strings filled in; the module's own default export is left out. */
export function withMissing(upstream: Record<string, unknown>): Pack {
  const { default: _default, ...sections } = upstream;
  return under(missing, sections as Pack);
}
