---
layout: home
hero:
  name: Boilerhouse
  text: Multi-tenant container orchestration
  tagline: Kubernetes-native workloads, pools, claims, and triggers for isolated per-tenant containers with pooling and hibernation.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/what-is-boilerhouse
    - theme: alt
      text: API Reference
      link: /reference/api
features:
  - title: Kubernetes-Native
    details: Workloads, Pools, Claims, and Triggers are first-class Custom Resources. State lives in the K8s API — no database.
  - title: Instance Pooling
    details: Pre-warm instances so tenants get sub-second claim times. Automatic scaling within configured bounds.
  - title: Snapshots & Hibernation
    details: Hibernate idle instances and restore them on demand. Overlay filesystems preserve tenant state.
  - title: Triggers & Integrations
    details: React to webhooks, Telegram messages, and cron schedules. Extensible driver and guard system.
---
