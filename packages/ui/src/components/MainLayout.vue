<template>
  <div class="h-screen flex flex-col min-h-0 transition-colors duration-300">
    <!-- 顶部导航栏 -->

    <!-- 主要内容区域 -->
    <main class="flex-1 min-h-0 w-full mx-auto p-2 sm:p-4">
      <div class="flex flex-col lg:flex-row gap-2 sm:gap-4 h-full">
        <slot></slot>
      </div>
    </main>

    <!-- 弹窗插槽 -->
    <slot name="modals"></slot>

    <!-- 全局提示 -->
    <ToastUI />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ToastUI } from '../index'

const { t } = useI18n()
</script>

<style>
.custom-select {
  -webkit-appearance: none !important;
  -moz-appearance: none !important;
  appearance: none !important;
  background-image: none !important;
}

.custom-select::-ms-expand {
  display: none;
}
</style>