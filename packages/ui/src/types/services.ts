import type {
  IModelManager,
  ITemplateManager,
  IHistoryManager,
  IDataManager,
  ILLMService,
  IPromptService,
  ITemplateLanguageService,
  ICompareService
} from '@prompt-optimizer/core'

// FIXME: Temporary workaround for build issue. Should be imported from @prompt-optimizer/core
export interface IPreferenceService {
  get<T>(key: string, defaultValue: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * 统一的应用服务接口定义
 */
export interface AppServices {
  modelManager: IModelManager;
  templateManager: ITemplateManager;
  historyManager: IHistoryManager;
  dataManager: IDataManager;
  llmService: ILLMService;
  promptService: IPromptService;
  templateLanguageService: ITemplateLanguageService;
  preferenceService: IPreferenceService;
  compareService: ICompareService;
}