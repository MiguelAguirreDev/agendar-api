importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCT25mmO3VtQYGr8Cwzj2t-NIF3gsWkTOg',
  authDomain: 'clinicadelpieisabelaguiar.firebaseapp.com',
  projectId: 'clinicadelpieisabelaguiar',
  appId: '1:685381652711:web:859a412d8779b53d49d242'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification?.title || 'Nueva notificación';
  const notificationOptions = {
    body: payload.notification?.body || '',
    icon: '/imagenes/logo.png',
    badge: '/imagenes/logo.png',
    data: payload.data,
    actions: [
      { action: 'ver', title: 'Ver en admin' }
    ]
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'ver' || !event.action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes('/admin') && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow('/admin.html');
      })
    );
  }
});