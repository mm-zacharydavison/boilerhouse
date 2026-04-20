import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Boilerhouse",
  description: "Multi-tenant container orchestration platform",
  base: "/boilerhouse/",
  cleanUrls: true,
  vite: {
    ssr: {
      noExternal: ["vitepress-theme-zac"],
    },
  },
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
          text: "Features",
          items: [
            { text: "Networking & Security", link: "/guide/networking" },
            { text: "Triggers", link: "/guide/triggers" },
            { text: "Storage", link: "/guide/storage" },
            { text: "Observability", link: "/guide/observability" },
            { text: "Dashboard", link: "/guide/dashboard" },
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
          text: "API",
          items: [
            { text: "REST API", link: "/reference/api" },
            { text: "WebSocket Events", link: "/reference/websocket" },
            { text: "CLI (Legacy)", link: "/reference/cli" },
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
            { text: "State Machines", link: "/reference/state-machines" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/zdavison/boilerhouse" },
    ],
  },
});
