# google-sheet-addon-svelte-starter

A template repository to develop a Google Sheet add-on with Svelte + Vite.

## Demo screenshot
![image](https://user-images.githubusercontent.com/1285344/209518909-87a2ddaf-7cf4-4882-bea9-8326d255098a.png)

![google-sheet-addon-template](https://user-images.githubusercontent.com/1285344/209519244-fc6e6c39-0dad-43c7-81cf-db7f39e79a41.gif)


## Getting Started

1. Clone the repository and install npm dependencies. Please note that there are two projects that you need to install npm packages(one for the sidebar and the other one for the clasp).

   ```
   git clone https://github.com/basil2style/google-sheet-addon-svelte-starter my-project
   cd my-project
   npm install
   ```

1. Log in and authenticate with your Google account:

   ```

   npm run clasp:login

   ```

   You can also use npx for running clasp locally

1. Create a new Sheet project:

   ```

   npm run clasp:create

   ```

   Make sure that you've .clasp.json and appsscript.json files on the root folder before deploying.

   ![image](https://user-images.githubusercontent.com/1285344/209518808-4e3babda-a85e-47d3-a937-891571062e80.png)

1. Deploy the project:

   ```

   npm run deploy

   ```

1. Open the project:

   ```

   npm run clasp:open

   ```

   The sidebar/dist directory contains the bundled svelte code. We will copy the index.html from the dist folder to /src using the build:post script.

## .claspignore

   This is similar to .gitignore. You can use this to include only the necessary files.

## Test the add-on on Google Sheet

Once you followed the steps above and have the Apps Script project open, the following steps explain how to test the add-on:

1. Click **Extensions**, then **Select our Addon...**
1. Select **Open** to run the HTML file.

This opens the Svelte sidebar.

## Sidebar development

Navigate to the `sidebar` folder and develop & test the application as you would any regular Svelte application, i.e. `npm run dev`.

## Another addon template HTML development

Settings page will open as a modal dialog in Google Sheet rather than sidebar ui. To update, you need to uncomment `defineConfig.build.rollupOptions.input.settings` line & comment out the `defineConfig.build.rollupOptions.input.main`. Because, the output build is not working in Google Sheet when combine both inputs files.

Files to note:

- `sidebar/src/settings.ts`
- `sidebar/src/settings.html`
- `sidebar/vite.config.ts`
- `loadSettingsUI()` in `src/index.ts`

### CSS Framework

   I added Pico CSS framework for this project, but you can change it to your framework

### Routing

  - [svelte-spa-router](https://github.com/ItalyPaleAle/svelte-spa-router) 


## References

- [CLASP - Google Apps Script tutorial](https://blog.makeinfo.co/clasp-google-apps-script-tutorial)
- [google-docs-addon-svelte-template](https://github.com/mikenikles/google-docs-addon-svelte-template) -- Last Updated Mar 2020
