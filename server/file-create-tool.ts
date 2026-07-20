import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const FILE_CREATE_DESCRIPTION =
  "声明下一次 write 要写入的文件路径，供页面提前创建并实时展示文件；此工具不写磁盘";

export const FILE_CREATE_SYSTEM_GUIDELINES = [
  "每次调用 write 前，必须先调用 file_create 声明完全相同的 path。",
  "file_create 只用于页面实时预览，不会创建或修改磁盘文件；声明后仍必须调用 write 完成实际写入。",
  "多个文件必须按 file_create、write 的顺序逐个处理，不要先批量声明所有路径。"
];

export const fileCreateTool = defineTool({
  name: "file_create",
  label: "FileCreate",
  description: FILE_CREATE_DESCRIPTION,
  promptSnippet: "Call file_create with the target path immediately before every write call.",
  promptGuidelines: FILE_CREATE_SYSTEM_GUIDELINES,
  parameters: Type.Object({
    description: Type.String({
      minLength: 1,
      description: "面向用户简短说明为什么要创建这个文件"
    }),
    path: Type.String({
      minLength: 1,
      description: "下一次 write 将使用的项目内文件路径"
    })
  }),
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    return {
      content: [{
        type: "text",
        text: `已为页面声明文件：${String(params.path)}`
      }],
      details: { path: String(params.path) }
    };
  }
});
