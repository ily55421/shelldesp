import { ref } from 'vue'

const toasts = ref<{ id: number; msg: string }[]>([])
let counter = 0

export function useToast() {
  function show(msg: string, duration = 1800) {
    const id = ++counter
    toasts.value.push({ id, msg })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }
  return { toasts, show }
}
