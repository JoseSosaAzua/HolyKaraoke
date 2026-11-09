# HolyApps

Este repositorio reúne dos aplicaciones relacionadas con el reconocimiento de voz en español. Son proyectos independientes: cada una tiene sus propios requisitos, instalación y forma de ejecución.

## Aplicaciones

### HolyKaraoke

Aplicación web que escucha el micrófono y muestra la estrofa de una canción que se está cantando. Puede reconocer la voz con **Vosk local** o con **Deepgram en la nube**. Las canciones se guardan como archivos JSON en `HolyKaraoke/songs/`.

### VoiceModels

Aplicación de consola que transcribe en tiempo real lo que capta el micrófono usando Vosk instalado en el equipo. También informa métricas de reconocimiento. Es independiente de HolyKaraoke, aunque ambas pueden usar el mismo modelo de Vosk.

## Requisitos

- Windows y PowerShell.
- Node.js y npm para HolyKaraoke.
- Python 3.9 o posterior para Vosk en cualquiera de las aplicaciones.
- Un micrófono configurado en Windows.

## Ejecutar HolyKaraoke

Abre PowerShell y ejecuta:

```powershell
Set-Location C:\Dev\HolyApps\HolyKaraoke
npm install
npm run dev
```

Abre <http://localhost:5173>, selecciona una canción y un motor de reconocimiento, y pulsa **Escuchar**.

- **Vosk (local):** descarga y extrae el modelo español siguiendo las instrucciones de [HolyKaraoke/README.md](HolyKaraoke/README.md). No necesita una clave de API.
- **Deepgram (nube):** copia `.env.example` a `.env` en `HolyKaraoke`, agrega tu clave en `DEEPGRAM_API_KEY` y vuelve a iniciar el servidor. No compartas ni subas el archivo `.env`; contiene una clave privada.

## Ejecutar VoiceModels

En otra ventana de PowerShell:

```powershell
Set-Location C:\Dev\HolyApps\VoiceModels
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Descarga el modelo `vosk-model-small-es-0.42` desde la [página oficial de modelos de Vosk](https://alphacephei.com/vosk/models) y extrae la carpeta dentro de `VoiceModels\models\`, para que la ruta final sea:

```text
VoiceModels\models\vosk-model-small-es-0.42
```

Después, inicia la aplicación:

```powershell
python main.py
```

Habla en español y pulsa **Ctrl+C** para terminar. Para ver los micrófonos disponibles:

```powershell
python main.py --list-devices
```

## Pruebas

Ejecuta cada comando desde la carpeta de la aplicación correspondiente.

HolyKaraoke:

```powershell
npm run typecheck
```

VoiceModels:

```powershell
python -m unittest discover -s tests
```

HolyKaraoke también documenta pruebas de Vosk y seguimiento de palabras en [HolyKaraoke/README.md](HolyKaraoke/README.md).

## Estructura del repositorio

```text
HolyApps/
├── HolyKaraoke/   Aplicación web y servidor de reconocimiento
└── VoiceModels/   Aplicación de transcripción por consola
```

Cada aplicación tiene un README con instrucciones y detalles adicionales:

- [HolyKaraoke/README.md](HolyKaraoke/README.md)
- [VoiceModels/README.md](VoiceModels/README.md)

## Ideas para seguir mejorándolo

- Agregar canciones creando archivos JSON en `HolyKaraoke/songs/`.
- Mejorar la interfaz y el seguimiento de estrofas en HolyKaraoke.
- Comparar motores y ajustes de reconocimiento con las pruebas descritas en el README de HolyKaraoke.
- Mejorar la selección de micrófono, la transcripción y las métricas en VoiceModels.
- Documentar aquí cualquier nuevo requisito o paso de instalación para que sea fácil poner el proyecto en marcha.
