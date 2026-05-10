const admin = require('firebase-admin');
admin.initializeApp();

const { asistente } = require('./asistente');
const { procesarCartola } = require('./procesarCartola');

exports.asistente = asistente;
exports.procesarCartola = procesarCartola;
