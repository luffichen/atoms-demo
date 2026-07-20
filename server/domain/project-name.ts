const GENERIC_PREFIXES = [
  /^请(?:帮我)?/u,
  /^帮我/u,
  /^我想要?/u,
  /^please\s+/iu,
  /^build\s+(?:me\s+)?/iu,
  /^create\s+(?:me\s+)?/iu
];

const ENGLISH_TOPICS: Array<[RegExp, string]> = [
  [/\bcoffee\s+shop\b.*\blanding\s+page\b|\blanding\s+page\b.*\bcoffee\s+shop\b/iu, "咖啡店落地页"],
  [/\b(customer relationship management|crm)\b/iu, "客户关系管理"],
  [/\b(expense|spending|budget)\b.*\b(tracker|tracking|manager|management)\b/iu, "费用追踪"],
  [/\b(recipe|meal)\b.*\b(planner|planning|manager)\b/iu, "食谱规划"],
  [/\b(inventory|stock)\b/iu, "库存管理"],
  [/\b(appointment|reservation|booking)\b/iu, "预约系统"],
  [/\bproject\s+management\b/iu, "项目管理"],
  [/\blanding\s+page\b/iu, "落地页"],
  [/\b(todo|task)\b/iu, "待办事项"],
  [/\b(blog)\b/iu, "博客"],
  [/\b(weather)\b/iu, "天气应用"],
  [/\b(chat)\b/iu, "聊天应用"],
  [/\b(api|backend)\b/iu, "接口服务"],
  [/\b(cli|command line)\b/iu, "命令行工具"],
  [/\b(game)\b/iu, "小游戏"],
  [/\b(portfolio)\b/iu, "作品集网站"]
];

const ENGLISH_DOMAINS: Array<[RegExp, string]> = [
  [/\b(quantum|physics)\b/iu, "科研"],
  [/\b(research|study|academic)\b/iu, "研究"],
  [/\b(health|medical|fitness)\b/iu, "健康"],
  [/\b(finance|financial|accounting)\b/iu, "财务"],
  [/\b(sales|marketing)\b/iu, "营销"],
  [/\b(education|learning|course|student)\b/iu, "学习"],
  [/\b(travel|trip|tourism)\b/iu, "旅行"],
  [/\b(pet|animal)\b/iu, "宠物"],
  [/\b(team|collaboration)\b/iu, "团队协作"],
  [/\b(customer|client)\b/iu, "客户"],
  [/\b(employee|staff|human resources|hr)\b/iu, "员工"],
  [/\b(document|knowledge|note)\b/iu, "知识"]
];

const ENGLISH_PRODUCTS: Array<[RegExp, string]> = [
  [/\b(dashboard|analytics|reporting)\b/iu, "数据看板"],
  [/\b(tracker|tracking|monitor)\b/iu, "追踪工具"],
  [/\b(manager|management)\b/iu, "管理工具"],
  [/\b(calendar|schedule|scheduling)\b/iu, "日程工具"],
  [/\b(search|directory)\b/iu, "检索工具"],
  [/\b(editor|builder|generator)\b/iu, "创作工具"],
  [/\b(marketplace|store|shop|commerce)\b/iu, "商城"],
  [/\b(community|forum)\b/iu, "社区"],
  [/\b(workflow|automation)\b/iu, "自动化工具"],
  [/\b(website|web\s+site|webpage)\b/iu, "网站"],
  [/\b(app|application)\b/iu, "应用"]
];

const GENERIC_CHINESE_PREFIXES = /^(?:一个|一款|用于|关于|可以|能够|用来)+/u;
const GENERIC_CHINESE_SUFFIXES = /(?:网页|网站|应用程序|应用|系统|平台|工具|页面)+$/u;
const MEANINGLESS_ENGLISH_REQUEST =
  /^(?:(?:an?|the|some|new)\s+)?(?:thing|something|project|product|solution|stuff)$/iu;

function removeGenericPrefixes(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    result = GENERIC_PREFIXES.reduce((current, pattern) => current.replace(pattern, ""), result).trim();
  } while (result !== previous);
  return result;
}

function extractChineseTopic(value: string): string {
  const chineseOnly = value
    .replace(/[A-Za-z0-9_-]+/gu, " ")
    .replace(/[^\p{Script=Han}\s]/gu, " ")
    .replace(/\s+/gu, "")
    .replace(GENERIC_CHINESE_PREFIXES, "")
    .replace(GENERIC_CHINESE_SUFFIXES, "")
    .trim();
  return chineseOnly;
}

function translateGenericEnglish(value: string): string | null {
  const normalized = removeGenericPrefixes(value)
    .replace(/\b(?:for|with|that|which|to|of|and)\b.*$/iu, "")
    .trim();
  if (!normalized || MEANINGLESS_ENGLISH_REQUEST.test(normalized)) return null;
  const domain = ENGLISH_DOMAINS.find(([pattern]) => pattern.test(value))?.[1] ?? "";
  const product = ENGLISH_PRODUCTS.find(([pattern]) => pattern.test(value))?.[1] ?? "";
  if (domain || product) return `${domain}${product || "应用"}`;
  return "定制项目";
}

export function fallbackProjectName(request: string): string {
  const compact = request.trim().replace(/\s+/gu, " ");
  for (const [pattern, translated] of ENGLISH_TOPICS) {
    if (pattern.test(compact)) return translated;
  }
  const withoutPrefix = removeGenericPrefixes(compact);
  const chineseTopic = extractChineseTopic(withoutPrefix);
  let name = (chineseTopic || withoutPrefix)
    .replace(/[。！？!?，,；;：:]+.*$/u, "")
    .trim();
  if (!name) return "新项目";
  if (/^[\x00-\x7F]+$/u.test(name)) name = translateGenericEnglish(name) ?? "新项目";
  const characters = Array.from(name);
  if (characters.length > 20) name = characters.slice(0, 18).join("") + "应用";
  return name || "新项目";
}
