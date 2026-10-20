<script setup lang="ts">
import { onMounted, ref } from 'vue'

const health = ref<string>('checking...')

onMounted(async () => {
  try {
    const res = await fetch('/api/health')
    const body: { ok: boolean; schemaVersion: number } = await res.json()
    health.value = `server ok, schema version ${body.schemaVersion}`
  } catch {
    health.value = 'server unreachable'
  }
})
</script>

<template>
  <main>
    <h1>Tasuki</h1>
    <p>{{ health }}</p>
  </main>
</template>
