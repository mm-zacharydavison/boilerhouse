import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Boilerhouse",
  description: "Multi-tenant container orchestration platform",
  base: "/boilerhouse/",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-is-boilerhouse" },
      { text: "Reference", link: "/reference/api" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is Boilerhouse?", link: "/guide/what-is-boilerhouse" },
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            { text: "Workloads", link: "/guide/workloads" },
            { text: "Instances", link: "/guide/instances" },
            { text: "Tenants & Claims", link: "/guide/tenants" },
            { text: "Pooling", link: "/guide/pooling" },
            { text: "Snapshots & Hibernation", link: "/guide/snapshots" },
          ],
        },
        {
          text: "Runtimes",
          items: [
            { text: "Docker", link: "/guide/runtime-docker" },
            { text: "Kubernetes Operator", link: "/guide/runtime-kubernetes" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "Networking & Security", link: "/guide/networking" },
            { text: "Triggers", link: "/guide/triggers" },
            { text: "Storage", link: "/guide/storage" },
            { text: "Observability", link: "/guide/observability" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Deployment", link: "/guide/deployment" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "API & CLI",
          items: [
            { text: "REST API", link: "/reference/api" },
            { text: "CLI", link: "/reference/cli" },
            { text: "WebSocket Events", link: "/reference/websocket" },
          ],
        },
        {
          text: "Configuration",
          items: [
            { text: "Workload Schema", link: "/reference/workload-schema" },
            { text: "Trigger Schema", link: "/reference/trigger-schema" },
            { text: "Environment Variables", link: "/reference/env" },
          ],
        },
        {
          text: "Kubernetes",
          items: [
            { text: "CRD Reference", link: "/reference/crds" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/zdavison/boilerhouse" },
    ],
  },
});
