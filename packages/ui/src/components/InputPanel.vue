<!-- 输入面板组件 -->
<template>
  <div class="space-y-3">
    <!-- 标题 -->

    <!-- 输入框 -->
    <div class="relative">
      <textarea
        :value="modelValue"
        @input="$emit('update:modelValue', $event.target.value)"
        class="w-full theme-input resize-none"
        :placeholder="placeholder"
        rows="1"
      ></textarea>
    </div>

    <!-- 控制面板 -->
    <div class="flex gap-2 flex-col ">

      <!-- 提示词模板选择 -->
      <div v-if="templateLabel" class="flex-1 min-w-0">
          <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-4">
            <div class="flex items-center space-x-3">
              <slot name="optimization-mode-selector"></slot>
            </div>
          </div>
      </div>

      <!-- 控制按钮组插槽 -->
      <slot name="control-buttons"></slot>

      <!-- 提交按钮 -->
      <div class="min-w-[60px] flex items-center">
        <div class="flex-1 mr-1">
          <slot name="template-select"></slot>
        </div>
        <button
          @click="$emit('submit')"
          :disabled="loading || disabled || !modelValue.trim()"
          class="w-24 h-10 theme-button-primary flex items-center truncate justify-center space-x-1"
        >
          <span>{{ loading ? loadingText : buttonText }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- 全屏弹窗 -->
  <FullscreenDialog v-model="isFullscreen" :title="label">
    <div class="h-full flex flex-col">
      <textarea
        v-model="fullscreenValue"
        class="w-full h-full min-h-[70vh] p-4 theme-input resize-none overflow-auto flex-1"
        :placeholder="placeholder"
      ></textarea>
    </div>
  </FullscreenDialog>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFullscreen } from '../composables/useFullscreen'
import FullscreenDialog from './FullscreenDialog.vue'

const { t } = useI18n()

const props = defineProps({
  modelValue: {
    type: String,
    required: true
  },
  selectedModel: {
    type: String,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  placeholder: {
    type: String,
    default: ''
  },
  modelLabel: {
    type: String,
    required: true
  },
  templateLabel: {
    type: String,
    default: ''
  },
  buttonText: {
    type: String,
    required: true
  },
  loadingText: {
    type: String,
    required: true
  },
  loading: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue', 'update:selectedModel', 'submit', 'configModel'])

// 使用全屏组合函数
const { isFullscreen, fullscreenValue, openFullscreen } = useFullscreen(
  computed(() => props.modelValue),
  (value) => emit('update:modelValue', value)
)
</script>