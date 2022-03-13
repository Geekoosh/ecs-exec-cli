declare module "inquirer-search-list" {
  export = Base;

  class Base {
    /**
     * Gets or sets a string which represents the state of the prompt.
     */
    status: PromptState;

    /**
     * Runs the prompt.
     *
     * @returns
     * The result of the prompt.
     */
    run(): Promise<any>;
  }
}
