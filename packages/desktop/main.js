// 在所有其他模块之前初始化日志系统
const ConsoleLogger = require('./config/console-logger');
const consoleLogger = new ConsoleLogger();

// 立即设置全局错误处理器，确保任何异常都能被记录
consoleLogger.setupGlobalErrorHandlers();

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const {
  buildReleaseUrl,
  validateVersion,
  IPC_EVENTS,
  PREFERENCE_KEYS,
  DEFAULT_CONFIG
} = require('./config/update-config');
const path = require('path');

// 确定正确的配置文件路径
// 在生产环境中，优先从exe所在目录查找.env.local文件
let envLocalPath;
if (app.isPackaged) {
  // 生产环境：exe所在目录
  envLocalPath = path.join(process.resourcesPath, '..', '.env.local');
} else {
  // 开发环境：项目根目录
  envLocalPath = path.resolve(__dirname, '../../.env.local');
}

const envPath = path.join(__dirname, '.env');

// 加载环境变量
require('dotenv').config({ path: envLocalPath });
require('dotenv').config({ path: envPath });


const {
  PreferenceService,
  createModelManager,
  createTemplateManager,
  createHistoryManager,
  createLLMService,
  createPromptService,
  createTemplateLanguageService,
  createDataManager,
  FileStorageProvider,
  // 导入共享的环境变量扫描常量
  CUSTOM_API_PATTERN,
  SUFFIX_PATTERN,
  MAX_SUFFIX_LENGTH,
} = require('@prompt-optimizer/core');

/**
 * 安全序列化函数，用于清理Vue响应式对象
 * 确保所有通过IPC传递的对象都是纯净的JavaScript对象
 *
 * 这个函数解决的是IPC序列化问题，与存储层的数据一致性问题是不同的：
 * - IPC问题：Vue响应式对象无法被Electron序列化传递
 * - 存储问题：FileStorageProvider的数据一致性和恢复机制
 */
function safeSerialize(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // 对于基本类型，直接返回
  if (typeof obj !== 'object') {
    return obj;
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    console.error('[IPC Serialization] Failed to serialize object:', error);
    throw new Error(`Failed to serialize object for IPC: ${error.message}`);
  }
}

let mainWindow;
let modelManager, templateManager, historyManager, llmService, promptService, templateLanguageService, preferenceService, dataManager;
let storageProvider; // 全局存储提供器引用，用于退出时保存数据
let isQuitting = false; // 防止重复保存数据的标志
let isUpdaterQuitting = false; // 标识是否为更新安装退出，跳过数据保存
let forceQuitTimer = null; // 强制退出定时器
const MAX_SAVE_TIME = 5000; // 最大保存时间：5秒
let emergencyExitTimer = null; // 应急退出定时器
const EMERGENCY_EXIT_TIME = 10000; // 应急退出时间：10秒

// 应急退出机制：无论如何都要在10秒内退出
function setupEmergencyExit() {
  if (emergencyExitTimer) {
    clearTimeout(emergencyExitTimer);
  }

  emergencyExitTimer = setTimeout(() => {
    console.error('[DESKTOP] EMERGENCY EXIT: Force terminating process after 10 seconds');
    process.exit(1); // 强制终止进程
  }, EMERGENCY_EXIT_TIME);
}

async function initializePreferenceService(storageProvider) {
  console.log('[DESKTOP] Initializing PreferenceService with the provided storage provider...');
  preferenceService = new PreferenceService(storageProvider);
  console.log('[DESKTOP] PreferenceService initialized.');
}

function setupPreferenceHandlers() {
  ipcMain.handle('preference-get', async (event, key, defaultValue) => {
    try {
      const value = await preferenceService.get(key, defaultValue);
      return createSuccessResponse(value);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('preference-set', async (event, key, value) => {
    try {
      await preferenceService.set(key, value);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('preference-getAll', async (event) => {
    try {
      const result = await preferenceService.getAll();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Preference Import/Export Data handlers (for bulk operations)
  ipcMain.handle('preference-exportData', async (event) => {
    try {
      const result = await preferenceService.exportData();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('preference-importData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      await preferenceService.importData(safeData);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('preference-getDataType', async (event) => {
    try {
      const result = preferenceService.getDataType();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('preference-validateData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      const result = await preferenceService.validateData(safeData);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });
}

function createWindow() {
  // Create the browser window.
  // 根据平台选择合适的图标文件
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = path.join(__dirname, 'icons', 'app-icon.ico');
  } else if (process.platform === 'darwin') {
    iconPath = path.join(__dirname, 'icons', 'app-icon.icns');
  } else {
    // Linux 和其他平台，优先使用高分辨率 PNG
    const linuxIcons = [
      path.join(__dirname, 'icons', '512x512.png'),
      path.join(__dirname, 'icons', '256x256.png'),
      path.join(__dirname, 'icons', 'app-icon.png')
    ];
    iconPath = linuxIcons.find(icon => require('fs').existsSync(icon)) || linuxIcons[2];
  }

  // 检查图标文件是否存在
  if (require('fs').existsSync(iconPath)) {
    console.log('[Main Process] Using icon:', iconPath);
  } else {
    console.warn('[Main Process] Icon file not found:', iconPath);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath, // 设置窗口图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // In development, we can point to the vite dev server
  if (process.env.NODE_ENV === 'development') {
    console.log('[Main Process] Running in development mode, loading from Vite dev server');
    mainWindow.loadURL('http://localhost:18181');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the built file from the web package
    const webDistPath = path.join(__dirname, 'web-dist/index.html');
    console.log('[Main Process] Loading web app from:', webDistPath);
    if (require('fs').existsSync(webDistPath)) {
      mainWindow.loadFile(webDistPath);
    } else {
      console.error('[Main Process] Web dist not found at:', webDistPath);
      console.error('[Main Process] Please run: pnpm run build:web and ensure it is copied to the desktop package.');
    }
  }

  // 窗口关闭前保存数据
  mainWindow.on('close', async (event) => {
    // 如果是更新安装退出，直接关闭窗口，不保存数据
    if (isUpdaterQuitting) {
      console.log('[DESKTOP] Updater quit detected, skipping data save');
      return;
    }

    if (!isQuitting && storageProvider && typeof storageProvider.flush === 'function') {
      event.preventDefault(); // 阻止立即关闭
      isQuitting = true; // 设置退出标志

      // 启动应急退出机制
      setupEmergencyExit();

      // 设置强制退出定时器，确保程序不会卡住
      forceQuitTimer = setTimeout(() => {
        console.warn('[DESKTOP] Force closing window due to timeout');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      }, MAX_SAVE_TIME);

      try {
        console.log('[DESKTOP] Saving data before window close...');
        await Promise.race([
          storageProvider.flush(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Save timeout')), MAX_SAVE_TIME - 1000)
          )
        ]);
        console.log('[DESKTOP] Data saved successfully');
      } catch (error) {
        console.error('[DESKTOP] Failed to save data before close:', error);
      } finally {
        if (forceQuitTimer) {
          clearTimeout(forceQuitTimer);
          forceQuitTimer = null;
        }
        if (emergencyExitTimer) {
          clearTimeout(emergencyExitTimer);
          emergencyExitTimer = null;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      }
    }
  });

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object
    mainWindow = null;
  });
}

async function initializeServices() {
  try {
    console.log('[Main Process] Initializing core services...');
    
    // 设置环境变量，确保主进程能访问API密钥
    // 这些环境变量应该在启动桌面应用之前设置
    console.log('[Main Process] Checking environment variables...');

    // 静态环境变量
    const staticEnvVars = [
      'VITE_OPENAI_API_KEY',
      'VITE_GEMINI_API_KEY',
      'VITE_DEEPSEEK_API_KEY',
      'VITE_SILICONFLOW_API_KEY',
      'VITE_ZHIPU_API_KEY',
      'VITE_CUSTOM_API_KEY',
      'VITE_CUSTOM_API_BASE_URL',
      'VITE_CUSTOM_API_MODEL'
    ];

    // 扫描动态自定义模型环境变量
    // 使用统一的正则表达式模式和验证规则

    const dynamicEnvVars = Object.keys(process.env).filter(key => {
      const match = key.match(CUSTOM_API_PATTERN);
      if (!match) return false;

      const [, , suffix] = match;
      return suffix && suffix.length <= MAX_SUFFIX_LENGTH && SUFFIX_PATTERN.test(suffix);
    });

    const allEnvVars = [...staticEnvVars, ...dynamicEnvVars];

    let hasApiKeys = false;
    allEnvVars.forEach(envVar => {
      const value = process.env[envVar];
      if (value) {
        console.log(`[Main Process] Found ${envVar}: [CONFIGURED]`);
        hasApiKeys = true;
      } else {
        console.log(`[Main Process] Missing ${envVar}`);
      }
    });

    if (dynamicEnvVars.length > 0) {
      console.log(`[Main Process] Found ${dynamicEnvVars.length} dynamic custom model environment variables`);
    }
    
    if (!hasApiKeys) {
      console.warn('[Main Process] No API keys found in environment variables.');
      console.warn('[Main Process] Please set environment variables before starting the desktop app.');
      console.warn('[Main Process] Examples:');
      console.warn('[Main Process]   VITE_OPENAI_API_KEY=your_key_here npm start');
      console.warn('[Main Process]   VITE_CUSTOM_API_KEY_qwen3=your_qwen_key npm start');
      console.warn('[Main Process]   VITE_CUSTOM_API_KEY_claude=your_claude_key npm start');
    }
    
    console.log('[DESKTOP] Creating file storage provider for desktop environment');

    // 使用标准用户数据目录，支持自动更新
    const userDataPath = app.getPath('userData');
    console.log('[DESKTOP] Using standard user data directory for auto-update compatibility:', userDataPath);
    storageProvider = new FileStorageProvider(userDataPath);
    
    await initializePreferenceService(storageProvider);
    
    console.log('[DESKTOP] Creating model manager...');
    modelManager = createModelManager(storageProvider);
    
    console.log('[DESKTOP] Creating template language service...');
    templateLanguageService = createTemplateLanguageService(preferenceService);

    console.log('[DESKTOP] Initializing template language service...');
    await templateLanguageService.initialize();

    console.log('[DESKTOP] Creating template manager...');
    templateManager = createTemplateManager(storageProvider, templateLanguageService);
    
    console.log('[DESKTOP] Creating history manager...');
    historyManager = createHistoryManager(storageProvider, modelManager);
    
    console.log('[DESKTOP] Initializing model manager...');
    await modelManager.ensureInitialized();
    
    console.log('[DESKTOP] Creating LLM service...');
    llmService = createLLMService(modelManager);

    console.log('[DESKTOP] Creating Prompt service...');
    promptService = createPromptService(modelManager, llmService, templateManager, historyManager);
    
    console.log('[DESKTOP] Creating Data manager...');
    dataManager = createDataManager(modelManager, templateManager, historyManager, preferenceService);
    
    console.log('[Main Process] Core services initialized successfully.');
    
    return true;
  } catch (error) {
    console.error('[Main Process] Failed to initialize core services:', error);
    console.error('[Main Process] Error details:', error.stack);
    return false;
  }
}

// --- IPC Response Helpers ---
function createSuccessResponse(data) {
  return { success: true, data };
}

function createErrorResponse(error) {
  console.error('[Main Process IPC Error]', error);
  // 对于非 Error 实例，包装一下
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { success: false, error: errorMessage };
}

// 创建详细的错误响应，确保100%信息保真
function createDetailedErrorResponse(error) {
  const timestamp = new Date().toISOString();
  let detailedMessage = `[${timestamp}] Error Details:\n\n`;

  // 详细序列化错误信息
  if (error instanceof Error) {
    detailedMessage += `Message: ${error.message}\n`;

    if (error.name && error.name !== 'Error') {
      detailedMessage += `Type: ${error.name}\n`;
    }

    if (error.code) {
      detailedMessage += `Code: ${error.code}\n`;
    }

    if (error.statusCode) {
      detailedMessage += `HTTP Status: ${error.statusCode}\n`;
    }

    if (error.url) {
      detailedMessage += `URL: ${error.url}\n`;
    }

    if (error.stack) {
      detailedMessage += `\nStack Trace:\n${error.stack}\n`;
    }

    // 捕获其他可能的属性
    const otherProps = {};
    for (const key in error) {
      if (!['message', 'name', 'code', 'statusCode', 'url', 'stack'].includes(key)) {
        try {
          otherProps[key] = error[key];
        } catch (e) {
          otherProps[key] = `[Cannot serialize: ${e.message}]`;
        }
      }
    }

    if (Object.keys(otherProps).length > 0) {
      detailedMessage += `\nAdditional Properties:\n${JSON.stringify(otherProps, null, 2)}\n`;
    }
  } else {
    // 非 Error 对象的处理
    detailedMessage += `Value: ${String(error)}\n`;
    detailedMessage += `Type: ${typeof error}\n`;
  }

  // 兜底：完整的 JSON 序列化
  try {
    const jsonError = JSON.stringify(error, Object.getOwnPropertyNames(error), 2);
    if (jsonError && jsonError !== '{}' && jsonError !== 'null') {
      detailedMessage += `\nComplete Object Dump:\n${jsonError}`;
    }
  } catch (jsonError) {
    detailedMessage += `\nJSON Serialization Failed: ${jsonError.message}`;
  }

  // 同时在控制台输出详细信息
  console.error('[Detailed Error Info]', detailedMessage);

  return { success: false, error: detailedMessage };
}

// --- High-Level IPC Service Handlers ---
function setupIPC() {
  console.log('[Main Process] Setting up high-level service IPC handlers...');
  setupPreferenceHandlers();
  
  // LLM Service handlers
  ipcMain.handle('llm-testConnection', async (event, provider) => {
    try {
      await llmService.testConnection(provider);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('llm-sendMessage', async (event, messages, provider) => {
    try {
      const result = await llmService.sendMessage(messages, provider);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('llm-sendMessageStructured', async (event, messages, provider) => {
    try {
      const result = await llmService.sendMessageStructured(messages, provider);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('llm-fetchModelList', async (event, provider, customConfig) => {
    try {
      const result = await llmService.fetchModelList(provider, customConfig);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Streaming handler - more complex due to callbacks
  ipcMain.handle('llm-sendMessageStream', async (event, messages, provider, streamId) => {
    try {
      const callbacks = {
        onContent: (content) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            event.sender.send(`stream-content-${streamId}`, content);
          }
        },
        onThinking: (thinking) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            event.sender.send(`stream-thinking-${streamId}`, thinking);
          }
        },
        onFinish: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            event.sender.send(`stream-finish-${streamId}`);
          }
        },
        onError: (error) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            event.sender.send(`stream-error-${streamId}`, error.message);
          }
        }
      };
      
      await llmService.sendMessageStream(messages, provider, callbacks);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Prompt Service handlers
  ipcMain.handle('prompt-optimizePrompt', async (event, request) => {
    try {
      const result = await promptService.optimizePrompt(request);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-iteratePrompt', async (event, originalPrompt, lastOptimizedPrompt, iterateInput, modelKey, templateId) => {
    try {
      const result = await promptService.iteratePrompt(originalPrompt, lastOptimizedPrompt, iterateInput, modelKey, templateId);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-testPrompt', async (event, systemPrompt, userPrompt, modelKey) => {
    try {
      const result = await promptService.testPrompt(systemPrompt, userPrompt, modelKey);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-getHistory', async () => {
    try {
      const result = await historyManager.getHistory();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-getIterationChain', async (event, recordId) => {
    try {
      const result = await historyManager.getIterationChain(recordId);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Helper for creating stream handlers that send data to the renderer process
  const createIpcStreamHandlers = (window, streamId) => ({
    onToken: (token) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(`stream-token-${streamId}`, token);
      }
    },
    onReasoningToken: (token) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(`stream-reasoning-token-${streamId}`, token);
      }
    },
    onComplete: () => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(`stream-finish-${streamId}`);
      }
    },
    onError: (error) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(`stream-error-${streamId}`, error.message);
      }
    },
  });

  ipcMain.handle('prompt-optimizePromptStream', async (event, request, streamId) => {
    const streamHandlers = createIpcStreamHandlers(mainWindow, streamId);
    try {
      await promptService.optimizePromptStream(request, streamHandlers);
      return createSuccessResponse(null);
    } catch (error) {
      streamHandlers.onError(error);
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-iteratePromptStream', async (event, originalPrompt, lastOptimizedPrompt, iterateInput, modelKey, templateId, streamId) => {
    const streamHandlers = createIpcStreamHandlers(mainWindow, streamId);
    try {
      await promptService.iteratePromptStream(originalPrompt, lastOptimizedPrompt, iterateInput, modelKey, streamHandlers, templateId);
      return createSuccessResponse(null);
    } catch (error) {
      streamHandlers.onError(error);
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('prompt-testPromptStream', async (event, systemPrompt, userPrompt, modelKey, streamId) => {
    const streamHandlers = createIpcStreamHandlers(mainWindow, streamId);
    try {
      await promptService.testPromptStream(systemPrompt, userPrompt, modelKey, streamHandlers);
      return createSuccessResponse(null);
    } catch (error) {
      streamHandlers.onError(error);
      return createErrorResponse(error);
    }
  });

  // Model Manager handlers
  ipcMain.handle('model-getModels', async (event) => {
    try {
      const result = await modelManager.getAllModels();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-addModel', async (event, model) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeModel = safeSerialize(model);
      // model应该包含key和config，需要分离
      const { key, ...config } = safeModel;
      await modelManager.addModel(key, config);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-updateModel', async (event, id, updates) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeUpdates = safeSerialize(updates);
      await modelManager.updateModel(id, safeUpdates);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-deleteModel', async (event, id) => {
    try {
      await modelManager.deleteModel(id);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-ensureInitialized', async () => {
    try {
      await modelManager.ensureInitialized();
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-isInitialized', async () => {
    try {
      const result = await modelManager.isInitialized();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-getAllModels', async () => {
    try {
      const result = await modelManager.getAllModels();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-getEnabledModels', async (event) => {
    try {
      const result = await modelManager.getEnabledModels();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Model Import/Export Data handlers (for bulk operations)
  ipcMain.handle('model-exportData', async (event) => {
    try {
      const result = await modelManager.exportData();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-importData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      await modelManager.importData(safeData);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-getDataType', async (event) => {
    try {
      const result = modelManager.getDataType();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('model-validateData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      const result = await modelManager.validateData(safeData);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Template Manager handlers
  ipcMain.handle('template-getTemplates', async (event) => {
    try {
      const result = await templateManager.listTemplates();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-getTemplate', async (event, id) => {
    try {
      const result = await templateManager.getTemplate(id);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-createTemplate', async (event, template) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeTemplate = safeSerialize(template);
      await templateManager.saveTemplate(safeTemplate);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-updateTemplate', async (event, id, updates) => {
    try {
      // Get existing template and merge with updates
      const existingTemplate = await templateManager.getTemplate(id);
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeUpdates = safeSerialize(updates);
      const updatedTemplate = { ...existingTemplate, ...safeUpdates, id };
      await templateManager.saveTemplate(updatedTemplate);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-deleteTemplate', async (event, id) => {
    try {
      await templateManager.deleteTemplate(id);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-listTemplatesByType', async (event, type) => {
    try {
      const result = await templateManager.listTemplatesByType(type);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Template Import/Export handlers
  ipcMain.handle('template-exportTemplate', async (event, id) => {
    try {
      const result = await templateManager.exportTemplate(id);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-importTemplate', async (event, jsonString) => {
    try {
      await templateManager.importTemplate(jsonString);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Template Import/Export Data handlers (for bulk operations)
  ipcMain.handle('template-exportData', async (event) => {
    try {
      const result = await templateManager.exportData();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-importData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      await templateManager.importData(safeData);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-getDataType', async (event) => {
    try {
      const result = templateManager.getDataType();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-validateData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      const result = templateManager.validateData(safeData);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Template language handlers
  ipcMain.handle('template-changeBuiltinTemplateLanguage', async (event, language) => {
    try {
      await templateManager.changeBuiltinTemplateLanguage(language);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-getCurrentBuiltinTemplateLanguage', async (event) => {
    try {
      const result = await templateManager.getCurrentBuiltinTemplateLanguage();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-getSupportedBuiltinTemplateLanguages', async (event) => {
    try {
      const result = await templateManager.getSupportedBuiltinTemplateLanguages();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('template-getSupportedLanguages', async (event, template) => {
    try {
      const result = templateManager.getSupportedLanguages(template);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // History Manager handlers
  ipcMain.handle('history-getHistory', async (event) => {
    try {
      const result = await historyManager.getRecords();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-addRecord', async (event, record) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeRecord = safeSerialize(record);
      const result = await historyManager.addRecord(safeRecord);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-deleteRecord', async (event, id) => {
    try {
      await historyManager.deleteRecord(id);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-clearHistory', async (event) => {
    try {
      await historyManager.clearHistory();
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // 添加缺失的历史记录链功能
  ipcMain.handle('history-getIterationChain', async (event, recordId) => {
    try {
      const result = await historyManager.getIterationChain(recordId);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-getAllChains', async (event) => {
    try {
      const result = await historyManager.getAllChains();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-getChain', async (event, chainId) => {
    try {
      const result = await historyManager.getChain(chainId);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-createNewChain', async (event, record) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeRecord = safeSerialize(record);
      const result = await historyManager.createNewChain(safeRecord);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-addIteration', async (event, params) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeParams = safeSerialize(params);
      const result = await historyManager.addIteration(safeParams);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-deleteChain', async (event, chainId) => {
    try {
      await historyManager.deleteChain(chainId);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // History Import/Export Data handlers (for bulk operations)
  ipcMain.handle('history-exportData', async (event) => {
    try {
      const result = await historyManager.exportData();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-importData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      await historyManager.importData(safeData);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-getDataType', async (event) => {
    try {
      const result = historyManager.getDataType();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('history-validateData', async (event, data) => {
    try {
      // 清理Vue响应式对象，防止IPC序列化错误
      const safeData = safeSerialize(data);
      const result = await historyManager.validateData(safeData);
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // Data Manager handlers
  ipcMain.handle('data-exportAllData', async (event) => {
    try {
      const result = await dataManager.exportAllData();
      return createSuccessResponse(result);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('data-importAllData', async (event, dataString) => {
    try {
      await dataManager.importAllData(dataString);
      return createSuccessResponse(null);
    } catch (error) {
      return createErrorResponse(error);
    }
  });



  // 环境配置同步 - 主进程作为唯一配置源
  ipcMain.handle('config-getEnvironmentVariables', async (event) => {
    try {
      // 静态环境变量
      const staticEnvVars = {
        VITE_OPENAI_API_KEY: process.env.VITE_OPENAI_API_KEY || '',
        VITE_GEMINI_API_KEY: process.env.VITE_GEMINI_API_KEY || '',
        VITE_DEEPSEEK_API_KEY: process.env.VITE_DEEPSEEK_API_KEY || '',
        VITE_SILICONFLOW_API_KEY: process.env.VITE_SILICONFLOW_API_KEY || '',
        VITE_ZHIPU_API_KEY: process.env.VITE_ZHIPU_API_KEY || '',
        VITE_CUSTOM_API_KEY: process.env.VITE_CUSTOM_API_KEY || '',
        VITE_CUSTOM_API_BASE_URL: process.env.VITE_CUSTOM_API_BASE_URL || '',
        VITE_CUSTOM_API_MODEL: process.env.VITE_CUSTOM_API_MODEL || ''
      };

      // 扫描动态自定义模型环境变量
      // 使用统一的正则表达式模式和验证规则

      const dynamicEnvVars = {};
      Object.keys(process.env).forEach(key => {
        const match = key.match(CUSTOM_API_PATTERN);
        if (match) {
          const [, , suffix] = match;
          if (suffix && suffix.length <= MAX_SUFFIX_LENGTH && SUFFIX_PATTERN.test(suffix)) {
            dynamicEnvVars[key] = process.env[key] || '';
          }
        }
      });

      // 合并所有环境变量
      const allEnvVars = {
        ...staticEnvVars,
        ...dynamicEnvVars
      };

      console.log('[Main Process] Environment variables requested by UI process');
      console.log(`[Main Process] Returning ${Object.keys(staticEnvVars).length} static + ${Object.keys(dynamicEnvVars).length} dynamic environment variables`);

      return createSuccessResponse(allEnvVars);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // 外部链接处理器
  ipcMain.handle('shell-openExternal', async (event, url) => {
    try {
      console.log('[Main Process] Opening external URL:', url);
      // 安全性检查：仅允许 http/https 协议
      const urlObj = new URL(url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new Error(`Unsupported protocol: ${urlObj.protocol}`);
      }
      await shell.openExternal(url);
      return createSuccessResponse(true);
    } catch (error) {
      console.error('[Main Process] Failed to open external URL:', error);
      return createErrorResponse(error);
    }
  });

  // 应用信息处理器
  ipcMain.handle('app-get-version', () => {
    try {
      const packageJson = require('./package.json');
      return createSuccessResponse(packageJson.version);
    } catch (error) {
      console.error('[Main Process] Failed to get app version:', error);
      return createErrorResponse(error);
    }
  });

  // 日志相关处理器
  ipcMain.handle('logs-get-paths', () => {
    try {
      const paths = consoleLogger.getLogPaths();
      return createSuccessResponse(paths);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  ipcMain.handle('logs-open-directory', async () => {
    try {
      const { logDir } = consoleLogger.getLogPaths();
      await shell.openPath(logDir);
      return createSuccessResponse(true);
    } catch (error) {
      return createErrorResponse(error);
    }
  });

  // 自动更新相关处理器
  setupUpdateHandlers();

  console.log('[Main Process] High-level service IPC handlers ready.');
}

// This method is called when Electron has finished initialization.
app.whenReady().then(async () => {
  const servicesInitialized = await initializeServices();
  if (servicesInitialized) {
    // 必须先设置IPC监听器，再创建窗口
    // 以防止窗口中的代码在监听器准备好之前就发送IPC消息
    setupIPC();
    createWindow();
  } else {
    console.error('[Main Process] Failed to start application due to service initialization failure.');
    // Optionally, show a dialog to the user
    // dialog.showErrorBox('Application Error', 'Could not initialize critical services.');
    app.quit();
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 进程信号处理器 - 最后的保障
process.on('SIGINT', () => {
  console.log('[DESKTOP] Received SIGINT, forcing exit...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[DESKTOP] Received SIGTERM, forcing exit...');
  process.exit(0);
});

// 全局异常处理已在 console-logger 中设置

// 应用退出前保存数据
app.on('before-quit', async (event) => {
  // 如果是更新安装退出，直接退出，不保存数据
  if (isUpdaterQuitting) {
    console.log('[DESKTOP] Updater quit detected, allowing immediate quit');
    return;
  }

  if (!isQuitting && storageProvider && typeof storageProvider.flush === 'function') {
    event.preventDefault(); // 阻止立即退出
    isQuitting = true; // 设置退出标志

    // 启动应急退出机制
    setupEmergencyExit();

    // 设置强制退出定时器，确保应用不会卡住
    const forceAppQuitTimer = setTimeout(() => {
      console.warn('[DESKTOP] Force quitting app due to timeout');
      process.exit(0); // 强制退出进程
    }, MAX_SAVE_TIME);

    try {
      console.log('[DESKTOP] Saving data before quit...');
      await Promise.race([
        storageProvider.flush(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Save timeout')), MAX_SAVE_TIME - 1000)
        )
      ]);
      console.log('[DESKTOP] Data saved successfully');
    } catch (error) {
      console.error('[DESKTOP] Failed to save data before quit:', error);
    } finally {
      clearTimeout(forceAppQuitTimer);
      if (emergencyExitTimer) {
        clearTimeout(emergencyExitTimer);
        emergencyExitTimer = null;
      }
      // 使用setImmediate确保在下一个事件循环中退出
      setImmediate(() => {
        isQuitting = false; // 重置标志以允许正常退出
        app.quit(); // 手动退出
      });
    }
  }
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 忽略版本管理辅助函数（全局作用域）
const getIgnoredVersions = async () => {
  try {
    const ignoredVersions = await preferenceService.get(PREFERENCE_KEYS.IGNORED_VERSIONS, null);
    if (ignoredVersions && typeof ignoredVersions === 'object') {
      return ignoredVersions;
    }
    return { stable: null, prerelease: null };
  } catch (error) {
    console.warn('[Updater] Failed to read ignored versions, using defaults:', error);
    return { stable: null, prerelease: null };
  }
};

const isVersionIgnored = async (version) => {
  const ignoredVersions = await getIgnoredVersions();
  const versionType = version.includes('-') ? 'prerelease' : 'stable';

  // 检查对应类型的忽略版本
  if (versionType === 'stable' && ignoredVersions.stable === version) {
    return true;
  }
  if (versionType === 'prerelease' && ignoredVersions.prerelease === version) {
    return true;
  }

  return false;
};

// 自动更新处理器设置
async function setupUpdateHandlers() {
  console.log('[Main Process] Setting up auto-update handlers...');



  // 更新操作状态锁，防止并发调用
  let isCheckingForUpdate = false;
  let isDownloadingUpdate = false;
  let isInstallingUpdate = false;

  // 配置更新器基本设置
  autoUpdater.autoDownload = DEFAULT_CONFIG.autoDownload;
  autoUpdater.allowPrerelease = DEFAULT_CONFIG.allowPrerelease;
  autoUpdater.allowDowngrade = false; // 默认不允许降级，只在渠道切换时临时启用

  // 环境变量动态配置支持（仅支持公开仓库）
  const defaultRepo = 'linshenkx/prompt-optimizer';
  let currentRepo = null;

  // 检测环境变量中的仓库信息
  if (process.env.GITHUB_REPOSITORY) {
    currentRepo = process.env.GITHUB_REPOSITORY;
  } else if (process.env.DEV_REPO_OWNER && process.env.DEV_REPO_NAME) {
    currentRepo = `${process.env.DEV_REPO_OWNER}/${process.env.DEV_REPO_NAME}`;
  }

  // 如果环境变量中的仓库与默认仓库不同，使用setFeedURL动态配置
  if (currentRepo && currentRepo !== defaultRepo) {
    try {
      const [owner, repo] = currentRepo.split('/');

      const feedConfig = {
        provider: 'github',
        owner,
        repo,
        private: false // 只支持公开仓库
      };

      console.log('[Updater] Using custom repository configuration:', {
        owner,
        repo,
        private: false,
        source: 'environment variables'
      });

      autoUpdater.setFeedURL(feedConfig);
    } catch (configError) {
      console.error('[Updater] Failed to configure custom repository:', configError);
      console.log('[Updater] Falling back to default configuration');
    }
  } else {
    console.log('[Updater] Using default repository configuration:', defaultRepo);
  }

  // 开发模式下的更新检查配置
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    console.log('[Updater] Development mode detected');
    
    // 设置开发环境专用的日志器（官方推荐）
    const log = require('electron-log');
    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'debug';
    autoUpdater.logger.transports.console.level = 'debug';
    
    // 为更新器创建专门的日志文件
    const userDataPath = app.getPath('userData');
    autoUpdater.logger.transports.file.resolvePathFn = () => 
      path.join(userDataPath, 'logs', 'auto-updater.log');
    
    // 强制启用开发模式更新检查
    autoUpdater.forceDevUpdateConfig = true;
    
    console.log('[Updater] Development mode configuration:');
    console.log('[Updater] - forceDevUpdateConfig: true');
    console.log('[Updater] - Looking for dev-app-update.yml in:', path.join(__dirname, 'dev-app-update.yml'));
    console.log('[Updater] - dev-app-update.yml exists:', require('fs').existsSync(path.join(__dirname, 'dev-app-update.yml')));
    
    console.log('[Updater] Development mode update testing enabled');
    console.log('[Updater] Auto-updater logs will be saved to:', path.join(userDataPath, 'logs', 'auto-updater.log'));
  }

  // 设置更新事件处理 - 仅在应用启动时设置一次
  autoUpdater.on('update-available', async (info) => {
    console.log('[Updater] Update available:', info);

    try {
      // 验证版本号格式
      if (!validateVersion(info.version)) {
        console.error('[Updater] Invalid version format:', info.version);
        return;
      }

      // 检查版本是否被忽略
      try {
        const isIgnored = await isVersionIgnored(info.version);
        if (isIgnored) {
          console.log('[Updater] Ignoring version:', info.version);
          return;
        }
      } catch (prefError) {
        console.warn('[Updater] Failed to check ignored versions, continuing with update check:', prefError);
        // 继续执行，不阻断更新流程
      }

      // 构建安全的GitHub Release页面链接
      let releaseUrl;
      try {
        releaseUrl = buildReleaseUrl(info.version);
      } catch (urlError) {
        console.error('[Updater] Failed to build release URL:', urlError);
        // 使用fallback URL或跳过URL
        releaseUrl = null;
      }

      // 发送更新可用通知到UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_EVENTS.UPDATE_AVAILABLE_INFO, {
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes,
          releaseUrl: releaseUrl
        });
      }
    } catch (error) {
      console.error('[Updater] Critical error in update-available handler:', error);
      // 即使出错也要通知用户有更新可用，但不包含详细信息
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_EVENTS.UPDATE_AVAILABLE_INFO, {
          version: info.version || 'Unknown',
          releaseDate: info.releaseDate || null,
          releaseNotes: null,
          releaseUrl: null,
          error: 'Failed to process update information'
        });
      }
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] No update available:', info);
    // 注意：现在这个事件监听器主要用于日志记录
    // 实际的UI更新逻辑已经移到前端的请求-响应模式中
    // 这样避免了竞争条件和全局状态的问题
  });

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Update error:', error);

    // 如果是 403 错误，提供基本的调试信息
    if (error.code === 'HTTP_ERROR_403' || (error.message && error.message.includes('403'))) {
      console.log('[Updater Debug] ===== 403 ERROR DEBUGGING =====');
      console.log('[Updater Debug] This is a 403 Forbidden error, likely repository access issue');

      console.log('[Updater Debug] Common 403 causes:');
      console.log('[Updater Debug] 1. Repository is private (not supported)');
      console.log('[Updater Debug] 2. Repository does not exist');
      console.log('[Updater Debug] 3. Network/firewall blocking GitHub API');
      console.log('[Updater Debug] 4. GitHub API rate limiting');

      console.log('[Updater Debug] Error details:', {
        code: error.code,
        message: error.message,
        stack: error.stack
      });
      console.log('[Updater Debug] =====================================');
    }

    // 重置所有状态锁，允许用户重试
    isCheckingForUpdate = false;
    isDownloadingUpdate = false;
    isInstallingUpdate = false;

    // 创建详细的错误信息
    const detailedErrorResponse = createDetailedErrorResponse(error);

    // 发送详细错误事件到UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.UPDATE_ERROR, {
        message: detailedErrorResponse.error,
        code: error.code || 'UNKNOWN_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log('[Updater] Download progress:', progress);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.UPDATE_DOWNLOAD_PROGRESS, progress);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info);
    console.log('[Updater] ===== UPDATE READY FOR INSTALLATION =====');
    console.log('[Updater] Downloaded version:', info.version);
    console.log('[Updater] Release date:', info.releaseDate);
    console.log('[Updater] Next step: User needs to click "Install and Restart" to complete the update');
    console.log('[Updater] The application will automatically restart after installation');
    console.log('[Updater] =============================================');
    
    // 下载完成，重置下载状态
    isDownloadingUpdate = false;
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 发送更详细的信息给前端，包含安装提示
      mainWindow.webContents.send(IPC_EVENTS.UPDATE_DOWNLOADED, {
        ...info,
        message: 'Update downloaded successfully. Click "Install and Restart" to complete the installation.',
        needsRestart: true,
        canInstallNow: true,
        installAction: 'Click the install button to restart and apply the update'
      });
    }
  });

  // 检查更新 - 直接返回完整结果，避免全局状态
  ipcMain.handle(IPC_EVENTS.UPDATE_CHECK, async () => {
    // 检查是否已有更新检查在进行中
    if (isCheckingForUpdate) {
      console.log('[Updater] Update check already in progress, ignoring request');
      return createSuccessResponse({
        message: 'Update check already in progress',
        inProgress: true
      });
    }

    // 设置检查状态锁
    isCheckingForUpdate = true;

    try {
      // 读取用户偏好设置，使用错误边界处理和明确的备用方案
      let allowPrerelease = DEFAULT_CONFIG.allowPrerelease;
      try {
        allowPrerelease = await preferenceService.get(PREFERENCE_KEYS.ALLOW_PRERELEASE, DEFAULT_CONFIG.allowPrerelease);
        console.log('[Updater] Successfully read prerelease preference:', allowPrerelease);
      } catch (prefError) {
        console.warn('[Updater] PreferenceService unavailable, using safe default (stable releases only):', prefError);
        allowPrerelease = false; // 明确的安全默认值

        // 可选：通知用户偏好设置不可用
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('preference-service-warning', {
            message: 'Settings temporarily unavailable, using default configuration',
            timestamp: new Date().toISOString()
          });
        }
      }

      console.log('[Updater] Checking for updates with settings:', { allowPrerelease });

      // 配置更新器
      autoUpdater.allowPrerelease = allowPrerelease;

      // 执行更新检查
      console.log('[Updater] Starting update check...');
      
      // 在实际调用 checkForUpdates 前检查配置
      console.log('[Updater Debug] ===== PRE-CHECK CONFIGURATION =====');
      console.log('[Updater Debug] autoUpdater.allowPrerelease:', autoUpdater.allowPrerelease);
      console.log('[Updater Debug] autoUpdater.autoDownload:', autoUpdater.autoDownload);
      console.log('[Updater Debug] ===============================================');
      
      const result = await autoUpdater.checkForUpdates();

      console.log('[DEBUG] ===== BACKEND UPDATE CHECK RESULT =====');
      console.log('[DEBUG] autoUpdater.checkForUpdates() returned:', result);
      console.log('[DEBUG] Result type:', typeof result);
      console.log('[DEBUG] Result is null:', result === null);
      console.log('[DEBUG] Result is undefined:', result === undefined);
      if (result) {
        console.log('[DEBUG] Result.updateInfo:', result.updateInfo);
        console.log('[DEBUG] Result.updateInfo type:', typeof result.updateInfo);
      }
      console.log('[DEBUG] ==========================================');

      // 构建完整的响应数据，包含所有必要信息
      const currentVersion = require('./package.json').version;
      let responseData = {
        checkResult: result,
        currentVersion: currentVersion,
        hasUpdate: false,
        remoteVersion: null,
        remoteReleaseUrl: null,
        message: 'Update check completed'
      };

      if (result && result.updateInfo) {
        const updateInfo = result.updateInfo;
        responseData.remoteVersion = updateInfo.version;
        responseData.hasUpdate = updateInfo.version !== currentVersion;

        // 构建发布页面URL
        try {
          responseData.remoteReleaseUrl = buildReleaseUrl(updateInfo.version);
        } catch (urlError) {
          console.warn('[Updater] Failed to build release URL:', urlError);
        }

        if (responseData.hasUpdate) {
          responseData.message = `New version ${updateInfo.version} is available`;
        } else {
          responseData.message = `You are already using the latest version (${updateInfo.version})`;
        }

        console.log('[Updater] Successfully retrieved update info:', {
          remoteVersion: updateInfo.version,
          hasUpdate: responseData.hasUpdate,
          releaseUrl: responseData.remoteReleaseUrl
        });
      } else {
        // 没有获取到远程版本信息，这可能是配置或网络问题
        console.log('[Updater] No update info received - checking possible causes...');

        // 生产环境或配置了开发环境但仍然没有获取到信息
        console.warn('[Updater] No update info received - this may indicate a configuration or network issue');
        console.warn('[Updater] Possible causes:');
        console.warn('  - app-update.yml missing or misconfigured');
        console.warn('  - Network connectivity issues');
        console.warn('  - GitHub repository access issues');
        console.warn('  - Invalid repository configuration');

        responseData.message = 'Unable to check for updates - configuration or network issue';
        responseData.checkResult = null;
      }

      return createSuccessResponse(responseData);
    } catch (error) {
      console.error('[Updater] Check update failed:', error);
      const detailedResponse = createDetailedErrorResponse(error);
      console.error('[DEBUG] Detailed error response being sent:', detailedResponse);
      return detailedResponse;
    } finally {
      // 无论成功还是失败，都要释放锁
      isCheckingForUpdate = false;
      console.log('[Updater] Update check completed, lock released');
    }
  });

  // 统一检查所有版本（解决并发冲突问题）
  ipcMain.handle(IPC_EVENTS.UPDATE_CHECK_ALL_VERSIONS, async () => {
    console.log('[Updater] Starting unified version check for all versions');
    
    // 检查是否已有更新检查在进行中
    if (isCheckingForUpdate) {
      console.log('[Updater] Update check already in progress, ignoring request');
      return createSuccessResponse({
        message: 'Update check already in progress',
        inProgress: true
      });
    }

    // 设置检查状态锁
    isCheckingForUpdate = true;

    try {
      // 获取当前版本
      const currentVersion = require('./package.json').version;
      const results = {
        currentVersion,
        stable: null,
        prerelease: null
      };

      // 辅助函数：处理单个版本检查结果
      const processResult = (result, versionType) => {
        if (!result || !result.updateInfo) {
          console.log(`[Updater] No ${versionType} update available`);
          return {
            hasUpdate: false,
            remoteVersion: null,
            remoteReleaseUrl: null,
            message: `No ${versionType} update available`,
            versionType,
            noVersionFound: true
          };
        }

        const updateInfo = result.updateInfo;
        const remoteVersion = updateInfo.version;

        // 预览版检查时，过滤掉正式版
        if (versionType === 'prerelease') {
          const isPrerelease = remoteVersion.includes('-');
          if (!isPrerelease) {
            return {
              hasUpdate: false,
              remoteVersion: null,
              remoteReleaseUrl: null,
              message: 'No newer prerelease available (latest release is stable)',
              versionType,
              noVersionFound: true,
              latestStableVersion: remoteVersion
            };
          }
        }

        // 简单但有效的版本比较：让前端处理复杂的语义化版本比较
        // 这里只需要确保返回远程版本信息，前端会进行准确的版本比较
        const hasUpdate = remoteVersion !== currentVersion;

        console.log(`[Updater] Version check for ${versionType}:`, {
          currentVersion,
          remoteVersion,
          hasUpdate: hasUpdate ? 'possible (will be verified by frontend)' : 'no'
        });
        let remoteReleaseUrl = null;

        // 构建发布页面URL
        try {
          remoteReleaseUrl = buildReleaseUrl(updateInfo.version);
        } catch (urlError) {
          console.warn(`[Updater] Failed to build ${versionType} release URL:`, urlError);
        }

        console.log(`[Updater] ${versionType} version check result:`, {
          remoteVersion,
          hasUpdate,
          releaseUrl: remoteReleaseUrl
        });

        return {
          hasUpdate,
          remoteVersion,
          remoteReleaseUrl,
          message: hasUpdate ?
            `New ${versionType} version ${remoteVersion} is available` :
            `You are already using the latest ${versionType} version`,
          versionType,
          releaseDate: updateInfo.releaseDate,
          releaseNotes: updateInfo.releaseNotes
        };
      };

      // 1. 检查正式版
      console.log('[Updater] Checking stable version...');
      autoUpdater.allowPrerelease = false;
      
      try {
        const stableResult = await autoUpdater.checkForUpdates();
        results.stable = processResult(stableResult, 'stable');
      } catch (error) {
        console.error('[Updater] Stable version check failed:', error);
        results.stable = {
          hasUpdate: false,
          remoteVersion: null,
          remoteReleaseUrl: null,
          message: `Stable version check failed: ${error.message}`,
          versionType: 'stable',
          error: error.message
        };
      }

      // 2. 延迟后检查预览版（避免状态冲突）
      console.log('[Updater] Waiting before checking prerelease version...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      console.log('[Updater] Checking prerelease version...');
      autoUpdater.allowPrerelease = true;
      
      try {
        const prereleaseResult = await autoUpdater.checkForUpdates();
        results.prerelease = processResult(prereleaseResult, 'prerelease');
      } catch (error) {
        console.error('[Updater] Prerelease version check failed:', error);
        results.prerelease = {
          hasUpdate: false,
          remoteVersion: null,
          remoteReleaseUrl: null,
          message: `Prerelease version check failed: ${error.message}`,
          versionType: 'prerelease',
          error: error.message
        };
      }

      // 3. 恢复用户偏好设置
      try {
        const userPreference = await preferenceService.get(PREFERENCE_KEYS.ALLOW_PRERELEASE, DEFAULT_CONFIG.allowPrerelease);
        autoUpdater.allowPrerelease = userPreference;
        autoUpdater.allowDowngrade = false; // 总是恢复为 false
        console.log('[Updater] Restored user preference:', { allowPrerelease: userPreference, allowDowngrade: false });
      } catch (prefError) {
        console.warn('[Updater] Failed to restore user preference, using default:', prefError);
        autoUpdater.allowPrerelease = DEFAULT_CONFIG.allowPrerelease;
        autoUpdater.allowDowngrade = false; // 确保在错误情况下也恢复
      }

      console.log('[Updater] Unified version check completed:', {
        stable: results.stable?.hasUpdate ? results.stable.remoteVersion : 'no update',
        prerelease: results.prerelease?.hasUpdate ? results.prerelease.remoteVersion : 'no update'
      });

      return createSuccessResponse(results);
    } catch (error) {
      console.error('[Updater] Unified version check failed:', error);
      return createDetailedErrorResponse(error);
    } finally {
      // 无论成功还是失败，都要释放锁
      isCheckingForUpdate = false;
      console.log('[Updater] Unified version check completed, lock released');
    }
  });

  // 开始下载更新
  ipcMain.handle(IPC_EVENTS.UPDATE_START_DOWNLOAD, async () => {
    // 检查是否已有下载在进行中
    if (isDownloadingUpdate) {
      console.log('[Updater] Download already in progress, ignoring request');
      return createSuccessResponse({
        message: 'Download already in progress',
        inProgress: true
      });
    }

    // 设置下载状态锁
    isDownloadingUpdate = true;

    try {
      console.log('[Updater] Starting update download...');
      await autoUpdater.downloadUpdate();
      return createSuccessResponse(null);
    } catch (error) {
      console.error('[Updater] Download failed:', error);
      isDownloadingUpdate = false; // 失败时重置状态
      return createDetailedErrorResponse(error);
    }
  });

  // 安装更新
  ipcMain.handle(IPC_EVENTS.UPDATE_INSTALL, async () => {
    // 检查是否已有安装在进行中
    if (isInstallingUpdate) {
      console.log('[Updater] Install already in progress, ignoring request');
      return createSuccessResponse({
        message: 'Install already in progress',
        inProgress: true
      });
    }

    // 设置安装状态锁
    isInstallingUpdate = true;

    try {
      console.log('[Updater] ===== STARTING UPDATE INSTALLATION =====');
      console.log('[Updater] User clicked "Install and Restart"');
      console.log('[Updater] The application will now close and restart with the new version');
      console.log('[Updater] If the application does not restart automatically, please launch it manually');
      console.log('[Updater] ==========================================');
      
      // 设置更新安装退出标志，跳过数据保存逻辑
      isUpdaterQuitting = true;
      console.log('[Updater] Set updater quit flag to skip data save');
      
      // 注意：quitAndInstall会立即退出应用，所以不会执行到finally
      // 这个方法会：
      // 1. 关闭当前应用
      // 2. 安装新版本
      // 3. 启动新版本的应用
      autoUpdater.quitAndInstall();
      
      // 这行代码通常不会执行到，因为 quitAndInstall() 会立即退出应用
      return createSuccessResponse({
        message: 'Installation started, application will restart'
      });
    } catch (error) {
      console.error('[Updater] Install failed:', error);
      console.error('[Updater] ===== INSTALLATION ERROR =====');
      console.error('[Updater] Error details:', error.message);
      console.error('[Updater] This may indicate:');
      console.error('[Updater] 1. Update file was corrupted during download');
      console.error('[Updater] 2. Insufficient permissions to install');
      console.error('[Updater] 3. Antivirus software blocked the installation');
      console.error('[Updater] 4. The update file was not properly downloaded');
      console.error('[Updater] Please try downloading the update again');
      console.error('[Updater] ===============================');
      
      return createDetailedErrorResponse(error);
    } finally {
      // 确保锁总是被释放（虽然quitAndInstall成功时不会执行到这里）
      isInstallingUpdate = false;
    }
  });

  // 获取忽略版本状态
  ipcMain.handle(IPC_EVENTS.UPDATE_GET_IGNORED_VERSIONS, async () => {
    try {
      const ignoredVersions = await getIgnoredVersions();
      console.log('[Updater] Retrieved ignored versions:', ignoredVersions);
      return createSuccessResponse(ignoredVersions);
    } catch (error) {
      console.error('[Updater] Failed to get ignored versions:', error);
      return createDetailedErrorResponse(error);
    }
  });

  // 忽略版本
  ipcMain.handle(IPC_EVENTS.UPDATE_IGNORE_VERSION, async (event, version, versionType) => {
    try {
      // 验证版本号格式
      if (!validateVersion(version)) {
        throw new Error(`Invalid version format: ${version}`);
      }

      // 如果没有指定类型，根据版本号自动判断
      if (!versionType) {
        versionType = version.includes('-') ? 'prerelease' : 'stable';
      }

      console.log('[Updater] Ignoring version:', version, 'type:', versionType);

      // 获取当前忽略版本数据
      const ignoredVersions = await getIgnoredVersions();

      // 更新对应类型的忽略版本
      ignoredVersions[versionType] = version;

      // 保存更新后的数据
      await preferenceService.set(PREFERENCE_KEYS.IGNORED_VERSIONS, ignoredVersions);

      return createSuccessResponse(null);
    } catch (error) {
      console.error('[Updater] Failed to ignore version:', error);
      return createDetailedErrorResponse(error);
    }
  });

  // 取消忽略版本
  ipcMain.handle(IPC_EVENTS.UPDATE_UNIGNORE_VERSION, async (event, versionType) => {
    try {
      // 验证版本类型
      if (!['stable', 'prerelease'].includes(versionType)) {
        throw new Error(`Invalid version type: ${versionType}`);
      }

      console.log('[Updater] Unignoring version type:', versionType);

      // 获取当前忽略版本数据
      const ignoredVersions = await getIgnoredVersions();

      // 清除对应类型的忽略版本
      ignoredVersions[versionType] = null;

      // 保存更新后的数据
      await preferenceService.set(PREFERENCE_KEYS.IGNORED_VERSIONS, ignoredVersions);

      return createSuccessResponse(null);
    } catch (error) {
      console.error('[Updater] Failed to unignore version:', error);
      return createDetailedErrorResponse(error);
    }
  });

  // 下载特定版本（原子操作）
  ipcMain.handle(IPC_EVENTS.UPDATE_DOWNLOAD_SPECIFIC_VERSION, async (event, versionType) => {
    try {
      console.log('[Updater] Starting atomic download for version type:', versionType);

      // 验证版本类型
      if (!['stable', 'prerelease'].includes(versionType)) {
        throw new Error(`Invalid version type: ${versionType}`);
      }

      // 防止并发下载 - 立即设置状态锁
      if (isDownloadingUpdate) {
        console.log('[Updater] Download already in progress');
        return createErrorResponse('Download already in progress');
      }

      // 立即设置下载状态，防止竞态条件
      isDownloadingUpdate = true;

      // 1. 保存当前配置（包括偏好设置和autoUpdater实例配置）
      const originalPreference = await preferenceService.get(PREFERENCE_KEYS.ALLOW_PRERELEASE, false);
      const originalAutoUpdaterConfig = {
        allowPrerelease: autoUpdater.allowPrerelease,
        allowDowngrade: autoUpdater.allowDowngrade
      };
      console.log('[Updater] Original preference:', originalPreference);
      console.log('[Updater] Original autoUpdater config:', originalAutoUpdaterConfig);

      try {
        // 2. 设置目标通道（同时修改偏好设置和autoUpdater实例）
        const targetPreference = versionType === 'prerelease';
        await preferenceService.set(PREFERENCE_KEYS.ALLOW_PRERELEASE, targetPreference);

        // 直接配置autoUpdater实例，确保本次操作使用正确配置
        autoUpdater.allowPrerelease = targetPreference;
        autoUpdater.allowDowngrade = true; // 允许降级，支持从预览版切换到正式版

        console.log('[Updater] Set preference to:', targetPreference);
        console.log('[Updater] Set autoUpdater config:', {
          allowPrerelease: autoUpdater.allowPrerelease,
          allowDowngrade: autoUpdater.allowDowngrade
        });

        // 3. 检查更新
        console.log('[Updater] Checking for updates...');
        const checkResult = await autoUpdater.checkForUpdates();

        if (!checkResult || !checkResult.updateInfo) {
          console.log('[Updater] No update available for', versionType);
          isDownloadingUpdate = false; // 重置状态
          return createSuccessResponse({
            hasUpdate: false,
            message: `No ${versionType} update available`,
            versionType,
            version: null,
            reason: 'no-update'
          });
        }

        // 检查版本是否被忽略
        const isIgnored = await isVersionIgnored(checkResult.updateInfo.version);
        if (isIgnored) {
          console.log('[Updater] Version is ignored:', checkResult.updateInfo.version);
          isDownloadingUpdate = false; // 重置状态
          return createSuccessResponse({
            hasUpdate: false,
            message: `Version ${checkResult.updateInfo.version} is ignored`,
            versionType,
            version: checkResult.updateInfo.version,
            reason: 'ignored'
          });
        }

        // 4. 立即开始下载
        console.log('[Updater] Starting download for version:', checkResult.updateInfo.version);
        // 注意：isDownloadingUpdate 已在函数开始时设置

        // 由于 autoDownload = false，必须手动调用 downloadUpdate()
        // 注意：不要 await downloadUpdate()，因为它会等到下载完成
        // 我们只需要启动下载，然后立即返回，避免超时问题
        try {
          // 启动下载（不等待完成）
          autoUpdater.downloadUpdate().catch(downloadError => {
            console.error('[Updater] Download failed:', downloadError);
            isDownloadingUpdate = false;
            // 发送错误事件到前端
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC_EVENTS.UPDATE_ERROR, {
                message: downloadError.message || 'Download failed',
                error: downloadError,
                timestamp: new Date().toISOString()
              });
            }
          });
          console.log('[Updater] Download started successfully');

          // 立即发送下载开始事件到前端，确保UI状态同步
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_EVENTS.UPDATE_DOWNLOAD_STARTED, {
              versionType,
              version: checkResult.updateInfo.version,
              timestamp: new Date().toISOString()
            });
          }
        } catch (downloadError) {
          console.error('[Updater] Failed to start download:', downloadError);
          isDownloadingUpdate = false;
          throw downloadError;
        }

        return createSuccessResponse({
          hasUpdate: true,
          updateInfo: checkResult.updateInfo,
          versionType,
          message: `Started downloading ${versionType} version ${checkResult.updateInfo.version}`
        });

      } finally {
        // 5. 确保恢复原始配置（偏好设置和autoUpdater实例）
        try {
          // 恢复偏好设置
          await preferenceService.set(PREFERENCE_KEYS.ALLOW_PRERELEASE, originalPreference);
          console.log('[Updater] Restored preference to:', originalPreference);

          // 恢复autoUpdater实例配置
          autoUpdater.allowPrerelease = originalAutoUpdaterConfig.allowPrerelease;
          autoUpdater.allowDowngrade = originalAutoUpdaterConfig.allowDowngrade;
          console.log('[Updater] Restored autoUpdater config to:', originalAutoUpdaterConfig);
        } catch (restoreError) {
          console.error('[Updater] Failed to restore configuration:', restoreError);
        }
      }

    } catch (error) {
      console.error('[Updater] Atomic download failed:', error);
      // 确保下载状态被重置
      if (isDownloadingUpdate) {
        isDownloadingUpdate = false;
      }
      return createDetailedErrorResponse(error);
    }
  });

  console.log('[Main Process] Auto-update handlers ready.');
}