// PlayerManager.js
// Manages party composition and character data

export default class PlayerManager {
  constructor() {
    this.party = [];
  }

  addCharacter(character) {
    this.party.push(character);
  }

  getParty() {
    return this.party;
  }
}
