import { ILLMService, Message, StreamHandlers, LLMResponse, ModelOption } from './types';
import { safeSerializeForIPC } from '../../utils/ipc-serialization';

/**
 * Electron环境下的LLM服务代理
 * 通过IPC调用主进程中的真实LLMService实例
 */
export class ElectronLLMProxy implements ILLMService {
  private electronAPI: NonNullable<Window['electronAPI']>;

  constructor() {
    // 验证Electron环境
    if (typeof window === 'undefined' || !window.electronAPI) {
      throw new Error('ElectronLLMProxy can only be used in Electron renderer process');
    }
    this.electronAPI = window.electronAPI;
  }

  async testConnection(provider: string): Promise<void> {
    await this.electronAPI.llm.testConnection(provider);
  }

  async sendMessage(messages: Message[], provider: string): Promise<string> {
    // 自动序列化，防止Vue响应式对象IPC传递错误
    const safeMessages = safeSerializeForIPC(messages);
    return this.electronAPI.llm.sendMessage(safeMessages, provider);
  }

  async sendMessageStructured(messages: Message[], provider: string): Promise<LLMResponse> {
    // 自动序列化，防止Vue响应式对象IPC传递错误
    const safeMessages = safeSerializeForIPC(messages);
    return this.electronAPI.llm.sendMessageStructured(safeMessages, provider);
  }

  async sendMessageStream(
    messages: Message[],
    provider: string,
    callbacks: StreamHandlers
  ): Promise<void> {
    // 自动序列化，防止Vue响应式对象IPC传递错误
    const safeMessages = safeSerializeForIPC(messages);

    // 适配回调接口：StreamHandlers 使用 onToken，而 preload 期望的是 onContent
    const adaptedCallbacks = {
      onContent: callbacks.onToken,  // 映射 onToken -> onContent
      onThinking: callbacks.onReasoningToken || (() => {}),  // 映射推理流
      onFinish: () => callbacks.onComplete(),  // 映射完成回调
      onError: callbacks.onError
    };

    await this.electronAPI.llm.sendMessageStream(safeMessages, provider, adaptedCallbacks);
  }

  async fetchModelList(
    provider: string,
    customConfig?: Partial<any>
  ): Promise<ModelOption[]> {
    // 自动序列化，防止Vue响应式对象IPC传递错误
    const safeCustomConfig = customConfig ? safeSerializeForIPC(customConfig) : customConfig;
    return this.electronAPI.llm.fetchModelList(provider, safeCustomConfig);
  }
} 