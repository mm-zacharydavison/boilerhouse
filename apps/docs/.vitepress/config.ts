import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Boilerhouse",
  description: "Multi-tenant container orchestration platform",
  base: "/boilerhouse/",
  cleanUrls: true,
  markdown: {
    theme: "github-light",
  },
  vite: {
    ssr: {
      noExternal: [
        "vitepress-theme-zac",
        "@fontsource-variable/dm-sans",
        "@fontsource-variable/jetbrains-mono",
      ],
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
            { text: "Tenants", link: "/guide/tenants" },
            { text: "Pooling", link: "/guide/pooling" },
            { text: "Snapshots & Hibernation", link: "/guide/snapshots" },
          ],
        },
        {
          text: "Runtimes",
          items: [
            { text: "Docker", link: "/guide/runtime-docker" },
            { text: "Kubernetes", link: "/guide/runtime-kubernetes" },
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
          text: "Reference",
          items: [
            { text: "REST API", link: "/reference/api" },
            { text: "CLI", link: "/reference/cli" },
            { text: "Workload Schema", link: "/reference/workload-schema" },
            { text: "CRDs", link: "/reference/crds" },
            { text: "State Machines", link: "/reference/state-machines" },
            { text: "Environment Variables", link: "/reference/env" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/zdavison/boilerhouse" },
    ],
  },
});
