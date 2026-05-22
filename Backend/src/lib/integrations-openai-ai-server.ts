export const openai = {
  chat: {
    completions: {
      create: async (_request: any) => ({
        choices: [{ message: { content: "{}" } }],
      }),
    },
  },
};
