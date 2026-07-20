import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageUploadError } from "../image-upload";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("空白内容禁用发送，Enter 提交而 Shift+Enter 不提交", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const change = vi.fn();
    const { rerender } = render(
      <Composer value="   " onChange={change} onSubmit={submit} />
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    rerender(<Composer value="有效需求" onChange={change} onSubmit={submit} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("只添加图片时仍不能发送", () => {
    render(<Composer value="" onChange={() => undefined} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("提交失败时保留文字与全部待发送图片", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const submit = vi.fn().mockRejectedValue(new Error("上传失败"));
    render(<Composer value="保留这条需求" onChange={() => undefined} onSubmit={submit} />);
    const input = screen.getByRole("textbox");
    const file = new File(["png"], "reference.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    expect(await screen.findByAltText("reference.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toHaveValue("保留这条需求");
    expect(screen.getByAltText("reference.png")).toBeInTheDocument();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("逐项标出上传失败图片并阻止不完整消息发送", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const submit = vi.fn().mockRejectedValue(
      new ImageUploadError(1, "broken.png", "图片“broken.png”上传失败：网络中断")
    );
    render(<Composer value="必须包含两张图" onChange={() => undefined} onSubmit={submit} />);
    const files = [
      new File(["ok"], "ok.png", { type: "image/png" }),
      new File(["bad"], "broken.png", { type: "image/png" })
    ];
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("broken.png");
    expect(screen.getByAltText("ok.png")).toBeInTheDocument();
    expect(screen.getByAltText("broken.png")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("必须包含两张图");
    expect(screen.getByRole("button", { name: "重试 broken.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试 ok.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(submit).toHaveBeenCalledWith(files);
  });

  it("移除失败图片后可以发送其余完整消息", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const submit = vi.fn()
      .mockRejectedValueOnce(new ImageUploadError(1, "broken.png"))
      .mockResolvedValueOnce(undefined);
    render(<Composer value="发送剩余图片" onChange={() => undefined} onSubmit={submit} />);
    const ok = new File(["ok"], "ok.png", { type: "image/png" });
    const broken = new File(["bad"], "broken.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [ok, broken] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "重试 broken.png" });

    fireEvent.click(screen.getByRole("button", { name: "移除 broken.png" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toEqual([ok]);
  });

  it("重试失败图片时重新提交完整消息且成功后清空图片", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const submit = vi.fn()
      .mockRejectedValueOnce(new ImageUploadError(0, "retry.png"))
      .mockResolvedValueOnce(undefined);
    render(<Composer value="重试后完整发送" onChange={() => undefined} onSubmit={submit} />);
    const file = new File(["retry"], "retry.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    fireEvent.click(await screen.findByRole("button", { name: "重试 retry.png" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toEqual([file]);
    await waitFor(() => expect(screen.queryByAltText("retry.png")).not.toBeInTheDocument());
  });

  it("预上传最多并发三张并逐项展示真实进度", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    const upload = vi.fn(
      async (file: File, onProgress: (progress: number) => void) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        onProgress(35);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        active -= 1;
        return { id: `upload-${file.name}` };
      }
    );
    render(
      <Composer
        value="批量图片"
        onChange={() => undefined}
        onSubmit={vi.fn()}
        onUpload={upload}
      />
    );
    const files = Array.from(
      { length: 8 },
      (_, index) => new File([String(index)], `${index}.png`, { type: "image/png" })
    );
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files } });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(3);
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    expect(screen.getAllByText("35%")).toHaveLength(3);
    resolvers.shift()?.();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    expect(maxActive).toBe(3);
    for (let expected = 5; expected <= 8; expected += 1) {
      await waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
      resolvers.shift()?.();
      await waitFor(() => expect(upload).toHaveBeenCalledTimes(expected));
    }
    while (resolvers.length) resolvers.shift()?.();
    await waitFor(() => expect(screen.getAllByText("已上传")).toHaveLength(8));
  });

  it("只重试失败图片，发送时提交上传 ID，移除时立即删除临时附件", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });
    const attempts = new Map<string, number>();
    const upload = vi.fn(async (file: File) => {
      const count = (attempts.get(file.name) ?? 0) + 1;
      attempts.set(file.name, count);
      if (file.name === "broken.png" && count === 1) throw new Error("网络中断");
      return { id: `upload-${file.name}-${count}` };
    });
    const remove = vi.fn().mockResolvedValue(undefined);
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        value="预上传发送"
        onChange={() => undefined}
        onSubmit={submit}
        onUpload={upload}
        onRemoveUpload={remove}
      />
    );
    const ok = new File(["ok"], "ok.png", { type: "image/png" });
    const broken = new File(["bad"], "broken.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [ok, broken] }
    });

    fireEvent.click(await screen.findByRole("button", { name: "重试 broken.png" }));
    await waitFor(() => expect(screen.getAllByText("已上传")).toHaveLength(2));
    expect(attempts.get("ok.png")).toBe(1);
    expect(attempts.get("broken.png")).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "移除 ok.png" }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("upload-ok.png-1")
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      [],
      ["upload-broken.png-2"]
    ));
  });

  it("任务运行且草稿为空时显示停止，输入内容后切换为发送", async () => {
    const stop = vi.fn();
    const submit = vi.fn().mockResolvedValue(undefined);
    const change = vi.fn();
    const { rerender } = render(
      <Composer
        value=""
        onChange={change}
        onSubmit={submit}
        running
        onStop={stop}
      />
    );

    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止当前任务" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();

    rerender(
      <Composer
        value="排队执行这条消息"
        onChange={change}
        onSubmit={submit}
        running
        onStop={stop}
      />
    );
    expect(screen.queryByRole("button", { name: "停止当前任务" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("队列已满不影响空草稿时停止当前任务", () => {
    const stop = vi.fn();
    render(
      <Composer
        value=""
        onChange={() => undefined}
        onSubmit={vi.fn()}
        running
        queueFull
        onStop={stop}
      />
    );
    const button = screen.getByRole("button", { name: "停止当前任务" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
