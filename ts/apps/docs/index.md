---
title: Boilerhouse
head:
  - - meta
    - http-equiv: refresh
      content: 0; url=./guide/what-is-boilerhouse
---

<script setup>
import { onMounted } from 'vue'
import { useRouter, withBase } from 'vitepress'

const router = useRouter()
onMounted(() => {
  router.go(withBase('/guide/what-is-boilerhouse'))
})
</script>

Redirecting to [What is Boilerhouse?](./guide/what-is-boilerhouse)…
