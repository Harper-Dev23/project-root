// QuestManager.js
// Handles quest definitions, states, and progression

export default class QuestManager {
  constructor() {
    this.quests = {};
  }

  addQuest(id, questData) {
    this.quests[id] = questData;
  }

  completeQuest(id) {
    if (this.quests[id]) this.quests[id].completed = true;
  }
}
