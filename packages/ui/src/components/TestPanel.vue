<template>
  <ContentCardUI>
<!--    <div class="flex flex-col h-full">-->
<!--      &lt;!&ndash; Test Input Area &ndash;&gt;-->

<!--      &lt;!&ndash; Test Results Area &ndash;&gt;-->
<!--    </div>-->
  </ContentCardUI>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '../composables/useToast'
import ContentCardUI from './ContentCard.vue'
import InputPanelUI from './InputPanel.vue'
import ModelSelectUI from './ModelSelect.vue'
import OutputDisplay from './OutputDisplay.vue'

const { t } = useI18n()
const toast = useToast()

const props = defineProps({
  promptService: {
    type: [Object, null],
    required: true
  },
  originalPrompt: {
    type: String,
    default: ''
  },
  optimizedPrompt: {
    type: String,
    default: ''
  },
  modelValue: {
    type: String,
    default: ''
  },
  optimizationMode: {
    type: String,
    default: 'system'
  }
})

const emit = defineEmits(['showConfig', 'update:modelValue'])

const isCompareMode = ref(true)
const testModelSelect = ref(null)
const selectedTestModel = ref(props.modelValue || '')

watch(() => props.modelValue, (newVal) => {
  if (newVal && newVal !== selectedTestModel.value) {
    selectedTestModel.value = newVal
  }
})

const updateSelectedModel = (value) => {
  selectedTestModel.value = value
  emit('update:modelValue', value)
}

const originalTestResult = ref('')
const originalTestError = ref('')
const isTestingOriginal = ref(false)

// 添加推理内容状态
const originalTestReasoning = ref('')

const optimizedTestResult = ref('')
const optimizedTestError = ref('')
const isTestingOptimized = ref(false)

// 添加推理内容状态
const optimizedTestReasoning = ref('')

const isTesting = computed(() => isTestingOriginal.value || isTestingOptimized.value)
const testContent = ref('')

const ensureString = (value) => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

const testOriginalPrompt = async () => {
  if (!props.originalPrompt) return

  isTestingOriginal.value = true
  originalTestResult.value = ''
  originalTestError.value = ''
  originalTestReasoning.value = ''

  await nextTick(); // 确保状态更新和DOM清空完成

  try {
    const streamHandler = {
      onToken: (token) => {
        originalTestResult.value += token
      },
      onReasoningToken: (reasoningToken) => {
        originalTestReasoning.value += reasoningToken
      },
      onComplete: () => { /* 流结束后不再需要设置 isTesting, 由 finally 处理 */ },
      onError: (err) => {
        const errorMessage = err.message || t('test.error.failed')
        originalTestError.value = errorMessage
        toast.error(errorMessage)
      }
    }

    let systemPrompt = ''
    let userPrompt = ''

    if (props.optimizationMode === 'user') {
      systemPrompt = ''
      userPrompt = ensureString(props.originalPrompt)
    } else {
      systemPrompt = ensureString(props.originalPrompt)
      userPrompt = testContent.value
    }

    await props.promptService.testPromptStream(
      systemPrompt,
      userPrompt,
      selectedTestModel.value,
      streamHandler
    )
  } catch (error) {
    console.error('[TestPanel] Original prompt test failed:', error); // 增加详细错误日志
    const errorMessage = error.message || t('test.error.failed')
    originalTestError.value = errorMessage
    toast.error(errorMessage)
    originalTestResult.value = ''
  } finally {
    // 确保无论成功或失败，加载状态最终都会被关闭
    isTestingOriginal.value = false
  }
}

const testOptimizedPrompt = async () => {
  if (!props.optimizedPrompt) return

  isTestingOptimized.value = true
  optimizedTestResult.value = ''
  optimizedTestError.value = ''
  optimizedTestReasoning.value = ''

  await nextTick(); // 确保状态更新和DOM清空完成

  try {
    const streamHandler = {
      onToken: (token) => {
        optimizedTestResult.value += token
      },
      onReasoningToken: (reasoningToken) => {
        optimizedTestReasoning.value += reasoningToken
      },
      onComplete: () => { /* 流结束后不再需要设置 isTesting, 由 finally 处理 */ },
      onError: (err) => {
        const errorMessage = err.message || t('test.error.failed')
        optimizedTestError.value = errorMessage
        toast.error(errorMessage)
      }
    }

    let systemPrompt = ''
    let userPrompt = ''

    if (props.optimizationMode === 'user') {
      systemPrompt = ''
      userPrompt = ensureString(props.optimizedPrompt)
    } else {
      systemPrompt = ensureString(props.optimizedPrompt)
      userPrompt = testContent.value
    }

    await props.promptService.testPromptStream(
      systemPrompt,
      userPrompt,
      selectedTestModel.value,
      streamHandler
    )
  } catch (error) {
    console.error('[TestPanel] Optimized prompt test failed:', error); // 增加详细错误日志
    const errorMessage = error.message || t('test.error.failed')
    optimizedTestError.value = errorMessage
    toast.error(errorMessage)
    optimizedTestResult.value = ''
  } finally {
    // 确保无论成功或失败，加载状态最终都会被关闭
    isTestingOptimized.value = false
  }
}

const handleTest = async () => {
  if (!selectedTestModel.value) {
    toast.error(t('test.error.noModel'))
    return
  }

  // For user prompt optimization, we don't need test content input
  // For system prompt optimization, we need test content input
  if (props.optimizationMode === 'system' && !testContent.value) {
    toast.error(t('test.error.noTestContent'))
    return
  }

  if (isCompareMode.value) {
    // Compare test mode: test both original and optimized prompts
    try {
      await Promise.all([
        testOriginalPrompt().catch(error => {
          console.error('[TestPanel] Original prompt test failed:', error)
          const errorMessage = error.message || t('test.error.failed')
          originalTestError.value = errorMessage
          toast.error(errorMessage)
        }),
        testOptimizedPrompt().catch(error => {
          console.error('[TestPanel] Optimized prompt test failed:', error)
          const errorMessage = error.message || t('test.error.failed')
          optimizedTestError.value = errorMessage
          toast.error(errorMessage)
        })
      ])
    } catch (error) {
      console.error('[TestPanel] Test process error:', error)
    }
  } else {
    // Normal test mode: only test optimized prompt
    await testOptimizedPrompt()
  }
}

onMounted(() => {
  if (props.modelValue) {
    selectedTestModel.value = props.modelValue
  }
})
</script>

<style scoped>
.theme-checkbox {
  width: 1rem;
  height: 1rem;
  border-radius: 0.25rem;
  cursor: pointer;
}
/* 小屏幕下允许容器自由扩展 */
@media (max-width: 767px) {
  .min-h-\[80px\] {
    min-height: 120px !important; /* 增加小屏幕下的最小高度 */
  }

  /* 确保OutputPanel可以正确扩展 */
  .flex-1 {
    flex: 1 0 auto;
  }
}
</style>