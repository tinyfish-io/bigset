<script lang="ts">
  import Header from "../lib/Header.svelte";
  import { wizard } from "../lib/wizardStore.js";
  import StepDescribe from "./StepDescribe.svelte";
  import StepGenerating from "./StepGenerating.svelte";
  import StepReview from "./StepReview.svelte";
  import StepPopulating from "./StepPopulating.svelte";
  import StepDone from "./StepDone.svelte";
</script>

<div class="home">
  <Header title="BigSet" />

  <main class="content">
    {#if $wizard.step === "describe"}
      <StepDescribe />
    {:else if $wizard.step === "generating"}
      <StepGenerating />
    {:else if $wizard.step === "review"}
      <StepReview />
    {:else if $wizard.step === "populating"}
      <StepPopulating />
    {:else if $wizard.step === "done"}
      <StepDone />
    {/if}
  </main>
</div>

<style>
  .home {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--background);
  }

  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
