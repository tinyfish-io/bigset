



export interface OpenRouterModel{

    modelName:string,
    canonicalSlug:string,
    contextLength:number,
    pricing:{
        completionCost:number,
        promptCost:number,
    }
}


export interface OpenRouterModelList{
    lastModified:string,
    models:OpenRouterModel[]
}


